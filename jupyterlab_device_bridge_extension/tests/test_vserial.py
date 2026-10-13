"""Tests of the virtual serial device: the pty, its symlink, the tool on it, the device directory.

A tool that opens, sets or closes the device is a child process, as an upload tool is.
"""

import asyncio
import logging
import os
import stat
import sys
import termios
import time

import pytest

from jupyterlab_device_bridge_extension import vserial
from jupyterlab_device_bridge_extension.shim import ShimSocket
from jupyterlab_device_bridge_extension.vserial import (
    DeviceDirError,
    VirtualSerial,
    default_device_dir,
    ensure_dir,
    read_speed,
)

BAUD = 115200
TRICKY = b"\r\n\n\r\x00\x03\x04\x11\x13\x1a\x7f\xff plain"
PROGRAM = os.path.basename(sys.executable)[:15]  # the kernel keeps 15 characters of a program name

# Opens the device, says so, and keeps it open until a line arrives on stdin.
HOLD = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
sys.stdin.readline()
"""

# Sets one baud rate per line on stdin: a standard rate with tcsetattr, any other with
# the termios2 call that pyserial uses for a custom rate.
SET_BAUD = """
import fcntl, os, struct, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
for line in sys.stdin:
    baud = int(line)
    if hasattr(termios, f"B{baud}"):
        settings = termios.tcgetattr(fd)
        settings[4] = settings[5] = getattr(termios, f"B{baud}")
        termios.tcsetattr(fd, termios.TCSANOW, settings)
    else:
        layout = struct.Struct("4IB19s2I")
        fields = list(layout.unpack(fcntl.ioctl(fd, 0x802C542A, bytes(layout.size))))
        fields[2] = (fields[2] & ~0o010017) | 0o010000
        fields[6] = fields[7] = baud
        fcntl.ioctl(fd, 0x402C542B, layout.pack(*fields))
    print("set", flush=True)
"""

# Makes the device a cooked terminal with echo, as a careless tool leaves it, and ends.
MAKE_COOKED = """
import os, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
settings = termios.tcgetattr(fd)
settings[0] |= termios.ICRNL | termios.IXON
settings[1] |= termios.OPOST | termios.ONLCR
settings[3] |= termios.ECHO | termios.ICANON | termios.ISIG
settings[4] = settings[5] = termios.B9600
termios.tcsetattr(fd, termios.TCSANOW, settings)
print("cooked", flush=True)
sys.stdin.readline()
"""

# Sets exclusive mode on the device, as the serial libraries of Go and Rust do at open.
EXCLUSIVE = """
import fcntl, os, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
fcntl.ioctl(fd, termios.TIOCEXCL)
print("open", flush=True)
sys.stdin.readline()
"""

# Opens, writes and closes at once, as `echo text > device` does.
WRITE_AND_CLOSE = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
os.write(fd, bytes(range(256)))
os.close(fd)
"""


class Listener:
    """Records what a `VirtualSerial` reports."""

    def __init__(self):
        self.events = []

    def tool_opened(self, holder, baud):
        self.events.append(("opened", holder, baud))

    def tool_baud(self, baud):
        self.events.append(("baud", baud))

    def tool_data(self, chunk):
        self.events.append(("data", chunk))

    def tool_closed(self):
        self.events.append(("closed",))

    def of(self, kind):
        return [event for event in self.events if event[0] == kind]

    def data(self):
        return b"".join(event[1] for event in self.of("data"))


async def until(condition, timeout=2.0):
    """Wait until `condition()` is true; return the seconds it took."""
    started = time.monotonic()
    while not condition():
        assert time.monotonic() - started < timeout, "not true in time"
        await asyncio.sleep(0.005)
    return time.monotonic() - started


@pytest.fixture
def serial(device_dir):
    """Factory: `device, listener = serial()` makes a virtual serial device on the running loop."""
    made = []

    def make():
        listener = Listener()
        made.append(VirtualSerial(os.path.join(device_dir, "tty-test"), BAUD, listener))
        return made[-1], listener

    yield make
    for device in made:
        device.close()


def masters():
    """How many pty masters this process has open."""
    links = (os.readlink(f"/proc/self/fd/{fd}") for fd in os.listdir("/proc/self/fd")
             if os.path.exists(f"/proc/self/fd/{fd}"))
    return sum(link.endswith("ptmx") for link in links)


def open_slave(device):
    """Open the device from the test's own process, without blocking."""
    return os.open(device.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)


async def read_slave(fd, count):
    """Read `count` bytes from a non-blocking descriptor on the device."""
    data = b""
    started = time.monotonic()
    while len(data) < count:
        assert time.monotonic() - started < 2, f"only {data!r} arrived"
        try:
            data += os.read(fd, count - len(data))
        except BlockingIOError:
            await asyncio.sleep(0.005)
    return data


async def assert_raw(device, listener):
    """Every byte passes both ways unchanged and nothing the port sent comes back to the port."""
    fd = open_slave(device)
    try:
        await until(lambda: device.held)
        device.write(TRICKY)
        assert await read_slave(fd, len(TRICKY)) == TRICKY
        await asyncio.sleep(0.1)
        assert listener.data() == b"", "the pty echoed bytes of the port back to the port"
        os.write(fd, TRICKY)
        await until(lambda: len(listener.data()) >= len(TRICKY))
        assert listener.data() == TRICKY
    finally:
        os.close(fd)
    await until(lambda: not device.held)


async def test_acc_serial_3_one_path_outside_dev_that_opens_as_a_terminal(serial, device_dir):
    """ACC-SERIAL-3 the device has one path under the device directory, outside /dev, that opens as a terminal device."""
    device, _ = serial()

    assert device.path == os.path.join(device_dir, "tty-test")
    assert stat.S_IMODE(os.lstat(device_dir).st_mode) == 0o700, "the device made its directory"
    assert os.listdir(device_dir) == ["tty-test"]
    assert not os.path.abspath(device.path).startswith("/dev/")
    fd = open_slave(device)
    try:
        assert os.isatty(fd)
        assert stat.S_ISCHR(os.fstat(fd).st_mode)
    finally:
        os.close(fd)


async def test_acc_serial_3_a_link_left_at_the_path_is_replaced_and_close_removes_it(device_dir):
    """ACC-SERIAL-3 a device takes its path over from a link an earlier server left there, and a closed device leaves no path behind."""
    os.mkdir(device_dir, 0o700)
    path = os.path.join(device_dir, "tty-test")
    os.symlink("/dev/null", path)

    device = VirtualSerial(path, BAUD, Listener())
    try:
        assert os.readlink(path) == device.slave_path == f"/dev/pts/{device.minor}"
    finally:
        device.close()

    assert not os.path.lexists(path)


async def test_acc_serial_8_a_fresh_device_is_raw(serial):
    """ACC-SERIAL-8 before a tool sets anything the device has no echo and no CR or LF translation."""
    device, listener = serial()

    await assert_raw(device, listener)


async def test_acc_serial_8_the_device_is_raw_again_after_a_tool_closed_it(serial, tool):
    """ACC-SERIAL-8 a tool that left echo and a line discipline behind does not change the device for the next tool."""
    device, listener = serial()
    child = await tool(MAKE_COOKED, device.path)
    assert await child.stdout.readline() == b"cooked\n"
    await until(lambda: device.held)
    child.stdin.write(b"\n")
    await child.wait()
    await until(lambda: listener.of("closed"))
    listener.events.clear()

    # Opened and closed with no pause between: the bridge does not see this as a tool.
    fd = open_slave(device)
    try:
        assert read_speed(fd) == BAUD
        assert not termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ICANON)
    finally:
        os.close(fd)
    await assert_raw(device, listener)


async def test_acc_serial_11_holder_pid_and_name_within_1_s(serial, tool):
    """ACC-SERIAL-11 a tool that opens the device is reported with its pid and program name within 1 s."""
    device, listener = serial()
    await asyncio.sleep(0.1)
    assert listener.events == [] and not device.held

    child = await tool(HOLD, device.path)
    assert await child.stdout.readline() == b"open\n"
    took = await until(lambda: listener.of("opened"), timeout=1.0)

    assert took < 1.0
    assert listener.events == [("opened", {"pid": child.pid, "name": PROGRAM}, BAUD)]
    assert device.held


async def test_acc_serial_12_tool_close_is_seen_within_1_s(serial, tool):
    """ACC-SERIAL-12 a tool that closes the device is reported within 1 s, and a second tool is seen again."""
    device, listener = serial()
    for _ in range(2):
        child = await tool(HOLD, device.path)
        assert await child.stdout.readline() == b"open\n"
        await until(lambda: listener.of("opened"))
        await asyncio.sleep(0.1)
        assert not listener.of("closed")

        child.stdin.write(b"\n")
        await child.wait()
        took = await until(lambda: listener.of("closed"), timeout=1.0)

        assert took < 1.0 and not device.held
        assert [event[0] for event in listener.events] == ["opened", "closed"]
        listener.events.clear()


async def test_acc_serial_12_a_tool_killed_in_exclusive_mode_does_not_lock_the_device(serial, tool):
    """ACC-SERIAL-12 after a tool that set exclusive mode was killed, the next tool opens the same path and finds a raw device."""
    device, listener = serial()
    locked_slave = device.slave_path
    child = await tool(EXCLUSIVE, device.path)
    assert await child.stdout.readline() == b"open\n"
    await until(lambda: listener.of("opened"))
    with pytest.raises(OSError, match="busy"):
        open_slave(device)

    child.kill()
    await child.wait()
    await until(lambda: listener.of("closed"))
    listener.events.clear()

    assert device.slave_path != locked_slave and os.readlink(device.path) == device.slave_path
    assert device.slave_path == f"/dev/pts/{device.minor}" and not device.held
    assert masters() == 1, "the pty that the tool locked is still open"
    await assert_raw(device, listener)


async def test_acc_serial_12_the_event_loop_is_idle_after_the_tool_closed(serial, tool):
    """ACC-SERIAL-12 after the tool closed the device the master is not watched: the event loop does not spin."""
    device, listener = serial()
    child = await tool(HOLD, device.path)
    assert await child.stdout.readline() == b"open\n"
    await until(lambda: listener.of("opened"))
    child.stdin.write(b"\n")
    await child.wait()
    await until(lambda: listener.of("closed"))

    used = time.process_time()
    await asyncio.sleep(0.5)
    used = time.process_time() - used

    assert used < 0.15, f"the loop used {used:.2f} s of processor time in 0.5 s"


async def test_acc_serial_9_the_baud_rate_a_tool_sets_is_reported(serial, tool):
    """ACC-SERIAL-9 each baud rate a tool sets is reported, also when the tool writes nothing and for a rate outside the standard table."""
    device, listener = serial()
    child = await tool(SET_BAUD, device.path)
    assert await child.stdout.readline() == b"open\n"
    await until(lambda: listener.of("opened"))

    for baud in (57600, 250000, 74880, 1200):
        child.stdin.write(f"{baud}\n".encode())
        assert await child.stdout.readline() == b"set\n"
        await until(lambda: listener.of("baud") and listener.of("baud")[-1] == ("baud", baud))

    assert listener.of("baud") == [("baud", 57600), ("baud", 250000), ("baud", 74880), ("baud", 1200)]
    assert listener.data() == b""
    child.stdin.close()
    await child.wait()
    await until(lambda: listener.of("closed"))
    fd = open_slave(device)
    try:
        assert read_speed(fd) == BAUD, "the device did not return to its own speed"
    finally:
        os.close(fd)


async def test_acc_serial_9_a_baud_rate_set_before_the_open_is_seen_comes_with_the_open(serial, tool):
    """ACC-SERIAL-9 a tool that sets its baud rate right after it opened the device is reported with that rate."""
    device, listener = serial()
    child = await tool(SET_BAUD, device.path)
    child.stdin.write(b"19200\n")
    assert await child.stdout.readline() == b"open\n"
    assert await child.stdout.readline() == b"set\n"
    await until(lambda: listener.of("opened"))
    await asyncio.sleep(0.1)

    rates = [event[2] for event in listener.of("opened")] + [event[1] for event in listener.of("baud")]
    assert rates[-1] == 19200 and set(rates) <= {BAUD, 19200}


async def test_acc_serial_5_a_tool_that_writes_and_closes_at_once_loses_nothing(serial, tool):
    """ACC-SERIAL-5 the 256 byte values of a tool that opens, writes and closes between two polls arrive in order."""
    device, listener = serial()
    child = await tool(WRITE_AND_CLOSE, device.path)
    await child.wait()

    await until(lambda: listener.of("closed"))

    assert listener.data() == bytes(range(256))
    assert [event[0] for event in listener.events if event[0] != "data"] == ["opened", "closed"]


async def test_acc_serial_13_bytes_for_no_tool_and_bytes_left_unread_do_not_reach_the_next_tool(serial, tool):
    """ACC-SERIAL-13 the next tool reads neither bytes the port sent while no tool held the device nor bytes the last tool left unread."""
    device, listener = serial()
    device.write(b"sent to nobody")
    child = await tool(HOLD, device.path)
    assert await child.stdout.readline() == b"open\n"
    await until(lambda: device.held)
    device.write(b"left unread " * 1000)
    await asyncio.sleep(0.1)
    child.stdin.write(b"\n")
    await child.wait()
    await until(lambda: listener.of("closed"))
    device.write(b"sent to nobody again")

    fd = open_slave(device)
    try:
        await until(lambda: device.held)
        await asyncio.sleep(0.1)
        with pytest.raises(BlockingIOError):
            os.read(fd, 65536)
        device.write(b"fresh")
        assert await read_slave(fd, 5) == b"fresh"
    finally:
        os.close(fd)


async def test_acc_serial_7_bytes_a_slow_tool_has_not_read_are_queued_in_order(serial):
    """ACC-SERIAL-7 1 MiB given to a tool that reads later than the port sends arrives whole and in order."""
    device, _ = serial()
    data = os.urandom(1024 * 1024)
    fd = open_slave(device)
    try:
        await until(lambda: device.held)
        for offset in range(0, len(data), 4096):
            device.write(data[offset:offset + 4096])
        await asyncio.sleep(0.2)

        received = await read_slave(fd, len(data))
    finally:
        os.close(fd)

    assert received == data


def test_acc_serial_127_run_devices_is_the_default_when_this_user_owns_it_or_can_make_it(tmp_path, monkeypatch, caplog):
    """ACC-SERIAL-127 with no setting the device directory is /run/devices when the server's user owns it, and when it is missing under a parent this user can write."""
    run_dir = tmp_path / "devices"
    monkeypatch.setattr(vserial, "RUN_DIR", str(run_dir))
    caplog.set_level(logging.INFO)

    assert default_device_dir(logging.getLogger(__name__)) == str(run_dir)
    assert not run_dir.exists(), "the choice makes no directory"
    run_dir.mkdir()
    assert default_device_dir(logging.getLogger(__name__)) == str(run_dir)
    assert caplog.text == ""


@pytest.mark.skipif(os.getuid() == 0, reason="root can write every directory")
@pytest.mark.parametrize("case", ["missing under a read-only parent", "a file", "a symlink", "another user's"])
def test_acc_serial_127_tmp_is_the_default_when_run_devices_is_not_usable(case, tmp_path, monkeypatch, caplog):
    """ACC-SERIAL-127 with no setting the device directory is /tmp/jupyterlab-device-<uid> when /run/devices is not a directory of this user and cannot be made, and the server logs both."""
    parent = tmp_path / "run"
    parent.mkdir()
    run_dir = parent / "devices"
    uid = os.getuid()
    if case == "a file":
        run_dir.write_text("")
    elif case == "a symlink":
        (tmp_path / "elsewhere").mkdir()
        run_dir.symlink_to(tmp_path / "elsewhere")
    elif case == "another user's":
        run_dir.mkdir()
        uid += 1
        monkeypatch.setattr(os, "getuid", lambda: uid)
    else:
        parent.chmod(0o500)
    monkeypatch.setattr(vserial, "RUN_DIR", str(run_dir))
    caplog.set_level(logging.INFO)

    chosen = default_device_dir(logging.getLogger(__name__))
    parent.chmod(0o700)

    assert chosen == f"/tmp/jupyterlab-device-{uid}"
    assert str(run_dir) in caplog.text and chosen in caplog.text


def test_acc_sec_95_the_device_directory_is_made_0700(tmp_path):
    """ACC-SEC-95 the device directory is created with mode 0700, and is accepted again once it exists."""
    path = str(tmp_path / "devices")

    ensure_dir(path)

    status = os.lstat(path)
    assert stat.S_ISDIR(status.st_mode) and stat.S_IMODE(status.st_mode) == 0o700
    ensure_dir(path)


def test_acc_sec_95_a_symlink_is_refused(tmp_path):
    """ACC-SEC-95 a device directory that is a symlink, to a directory or to nothing, or a file is refused."""
    (tmp_path / "real").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "real")
    (tmp_path / "dangling").symlink_to(tmp_path / "missing")
    (tmp_path / "file").write_text("")

    for name in ("link", "dangling", "file"):
        with pytest.raises(DeviceDirError, match="not a directory"):
            ensure_dir(str(tmp_path / name))
    assert os.listdir(tmp_path / "real") == [] and not (tmp_path / "missing").exists()


@pytest.mark.skipif(os.getuid() == 0, reason="root owns the directory this test points at")
def test_acc_sec_95_a_directory_of_another_user_is_refused():
    """ACC-SEC-95 a device directory that another user owns is refused."""
    assert os.stat("/usr").st_uid == 0

    with pytest.raises(DeviceDirError, match="owned by uid 0"):
        ensure_dir("/usr")


@pytest.mark.skipif(os.getuid() == 0, reason="the test proves the bridge for an unprivileged user")
async def test_acc_sec_97_only_symlinks_sockets_and_ptys(serial, device_dir):
    """ACC-SEC-97 as an unprivileged user the bridge makes a pty, a symlink to it and a socket, and nothing else."""
    device, _ = serial()
    shim_dir = os.path.join(device_dir, ".shim")
    ensure_dir(shim_dir)

    async def on_event(kind, values):
        pass

    socket = ShimSocket(shim_dir, device.minor, on_event)
    await socket.start()
    try:
        found = {}
        for root, directories, files in os.walk(device_dir):
            for entry in directories + files:
                path = os.path.join(root, entry)
                found[os.path.relpath(path, device_dir)] = os.lstat(path).st_mode

        assert set(found) == {"tty-test", ".shim", f".shim/pts-{device.minor}.sock"}
        assert stat.S_ISLNK(found["tty-test"])
        assert os.readlink(device.path) == f"/dev/pts/{device.minor}"
        assert stat.S_ISCHR(os.stat(device.path).st_mode) and os.stat(device.path).st_uid == os.getuid()
        assert stat.S_ISDIR(found[".shim"]) and stat.S_IMODE(found[".shim"]) == 0o700
        socket_mode = found[f".shim/pts-{device.minor}.sock"]
        assert stat.S_ISSOCK(socket_mode) and stat.S_IMODE(socket_mode) == 0o600
    finally:
        socket.close()
    assert os.listdir(shim_dir) == []
