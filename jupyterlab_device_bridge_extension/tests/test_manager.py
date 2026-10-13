"""Tests of the device manager through the real server: fake tabs on the WebSocket, tools as child processes."""

import asyncio
import atexit
import base64
import contextlib
import fcntl
import hashlib
import logging
import os
import pathlib
import pty
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import types

import pytest
from traitlets.config import Config

from jupyterlab_device_bridge_extension import DeviceBridge, _load_jupyter_server_extension, vserial
from jupyterlab_device_bridge_extension import manager as manager_module
from jupyterlab_device_bridge_extension.manager import DeviceManager
from jupyterlab_device_bridge_extension.routes import MANAGER_KEY
from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_KEY, SERIAL_NAME, FakeTab

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]

# Opens the device, says so, and keeps it open until a line arrives on stdin.
HOLD = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
sys.stdin.readline()
"""

# Writes the 256 byte values, then keeps the device open.
WRITE = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
os.write(fd, bytes(range(256)))
print("written", flush=True)
sys.stdin.readline()
"""

# Reads exactly argv[2] bytes and prints them as hex.
READ = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
count, data = int(sys.argv[2]), b""
while len(data) < count:
    data += os.read(fd, count - len(data))
print(data.hex(), flush=True)
sys.stdin.readline()
"""

# On the first line of stdin: sets 57600 baud and writes at once. Closes on the second.
BAUD_THEN_WRITE = """
import os, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
sys.stdin.readline()
settings = termios.tcgetattr(fd)
settings[4] = settings[5] = termios.B57600
termios.tcsetattr(fd, termios.TCSANOW, settings)
os.write(fd, b"after the baud change")
print("written", flush=True)
sys.stdin.readline()
"""

# On the first line of stdin: sets 57600 baud and tells the shim socket (argv[2]) its frame
# format at once, as the preload shim does inside one tcsetattr call of a tool.
BAUD_AND_FRAME = """
import os, socket, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
sys.stdin.readline()
settings = termios.tcgetattr(fd)
settings[4] = settings[5] = termios.B57600
termios.tcsetattr(fd, termios.TCSANOW, settings)
shim = socket.socket(socket.AF_UNIX)
shim.connect(sys.argv[2])
shim.sendall(b"T 8 E 1\\n")
print(shim.recv(8).decode().strip(), flush=True)
sys.stdin.readline()
"""

# pyserial as the tool: the library under miniterm and under many upload tools. It opens
# at 9600 baud, then changes to a rate outside the standard table.
PYSERIAL = """
import sys
import serial
port = serial.Serial(sys.argv[1], 9600, timeout=10)
port.write(b"ping")
print(port.read(4).decode(), port.baudrate, flush=True)
port.baudrate = 74880
port.write(b"pong")
print(port.read(4).decode(), port.baudrate, flush=True)
port.close()
"""

# Sets exclusive mode on the device, as the serial libraries of Go and Rust do at open.
EXCLUSIVE = """
import fcntl, os, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
fcntl.ioctl(fd, termios.TIOCEXCL)
print("open", flush=True)
sys.stdin.readline()
"""

# Writes 1 MiB while it reads 1 MiB back; prints the sha256 of both.
ECHO_1_MIB = """
import hashlib, os, sys, threading
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
data = os.urandom(1024 * 1024)
def send():
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view[:65536]):]
threading.Thread(target=send, daemon=True).start()
received = b""
while len(received) < len(data):
    received += os.read(fd, 65536)
print(hashlib.sha256(data).hexdigest(), hashlib.sha256(received).hexdigest(), flush=True)
"""

# Writes 64 KiB and says when the last write returned.
WRITE_64_KIB = """
import os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
view = memoryview(bytes(65536))
while view:
    view = view[os.write(fd, view):]
print("written", flush=True)
sys.stdin.readline()
"""

# Takes the lock on the directory argv[1], as a running server has it, and keeps it until
# a line arrives on stdin.
LOCK = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
fcntl.flock(fd, fcntl.LOCK_EX)
print("locked", flush=True)
sys.stdin.readline()
"""


def record(tab, name=SERIAL_NAME):
    """The serial record of the last device table a tab got."""
    return next(device for device in tab.devices["serial"] if device["name"] == name)


async def attach(fake_tab, tab_id="tab-1"):
    """A connected tab that holds the serial port, and the path of the virtual device."""
    tab = await fake_tab(tab_id)
    assert (await tab.claim_serial())["ok"]
    # The device table that lists the port arrives after the answer to the claim.
    await tab.until(lambda: any(
        device["name"] == SERIAL_NAME and device["portState"] == "open"
        for device in tab.devices["serial"]))
    return tab, record(tab)["path"]


async def line(child):
    """The next line a tool printed."""
    return await asyncio.wait_for(child.stdout.readline(), 20)


async def holding(tab, tool, script, path, *args):
    """Start a tool and wait until the bridge shows it as the holder of the device."""
    child = await tool(script, path, *args)
    assert await line(child) == b"open\n"
    await tab.until(lambda: record(tab)["holder"])
    return child


async def end(child):
    """Let a tool that waits on stdin close the device and end."""
    child.stdin.write(b"\n")
    await child.wait()


def configured(tab):
    """The baud rate of every `serial-configure` a tab got."""
    return [event["settings"]["baudRate"] for event in tab.got("serial-configure")]


def shim_socket(path):
    """The shim socket of the virtual device at `path`, found as the preload shim finds it."""
    minor = os.minor(os.stat(path).st_rdev)
    return os.path.join(os.path.dirname(path), ".shim", f"pts-{minor}.sock")


async def shim_says(path, text):
    """Send one line to the shim socket of a device as a plain client; the answer and the seconds it took."""
    reader, writer = await asyncio.open_unix_connection(shim_socket(path))
    started = time.monotonic()
    writer.write(text)
    answer = await asyncio.wait_for(reader.readline(), 5)
    took = time.monotonic() - started
    writer.close()
    return answer, took


def leave(device_dir):
    """Make a device directory as a killed server leaves it, with a regular file beside each entry.

    The link and the socket have names that no pty number gives, so no device of the
    test takes their place.

    Returns:
        The symlink in the device directory, the socket in its shim directory, and the two regular files.
    """
    shim_dir = os.path.join(device_dir, ".shim")
    os.mkdir(device_dir, 0o700)
    os.mkdir(shim_dir, 0o700)
    link, left_socket = os.path.join(device_dir, "tty-left"), os.path.join(shim_dir, "pts-left.sock")
    os.symlink("/dev/pts/left", link)
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(left_socket)
    files = [os.path.join(directory, "file") for directory in (device_dir, shim_dir)]
    for file in files:
        pathlib.Path(file).write_bytes(b"")
    return link, left_socket, files


# ------------------------------------------------------------------ names and ownership


async def test_acc_serial_3_an_attached_port_has_one_path_in_the_device_directory(fake_tab, device_dir):
    """ACC-SERIAL-3 an attached port has one path under the device directory, outside /dev, that is a terminal device."""
    tab, path = await attach(fake_tab)

    assert path == os.path.join(device_dir, SERIAL_NAME)
    assert tab.welcome["deviceDir"] == device_dir and not device_dir.startswith("/dev/")
    assert [entry for entry in os.listdir(device_dir) if entry != ".shim"] == [SERIAL_NAME]
    assert os.path.islink(path) and stat.S_ISCHR(os.stat(path).st_mode)
    assert stat.S_IMODE(os.lstat(device_dir).st_mode) == 0o700


async def test_acc_serial_4_same_name_and_path_after_detach_and_after_reconnect(fake_tab, api):
    """ACC-SERIAL-4 a port keeps its name and path after detach and attach, and after its tab reconnects."""
    tab = await fake_tab()
    first = await tab.claim_serial()
    path = record(tab)["path"]

    await tab.release(first["name"])
    await tab.until(lambda: record(tab)["state"] == "detached")
    second = await tab.claim_serial()
    assert (second["name"], second["sid"], record(tab)["path"]) == (first["name"], first["sid"], path)

    await tab.close()
    again = await fake_tab()
    third = await again.claim_serial()
    assert (third["name"], third["sid"], record(again)["path"]) == (first["name"], first["sid"], path)
    assert os.readlink(path).startswith("/dev/pts/")


async def test_acc_serial_4_a_tab_that_reconnects_takes_over_from_its_old_socket(fake_tab, api):
    """ACC-SERIAL-4 a tab that reconnects before its old socket closed gets its device back under the same name, and the old socket has no say any more."""
    old = await fake_tab("tab-1")
    first = await old.claim_serial()

    new = await fake_tab("tab-1")
    assert record(new)["state"] == "detached", "the devices of the replaced socket are detached"
    again = await new.claim_serial()
    assert (again["ok"], again["name"], again["sid"]) == (True, first["name"], first["sid"])

    await old.release(SERIAL_NAME, "forget")
    await old.port_sends(SERIAL_NAME, b"from the old socket")
    await new.port_sends(SERIAL_NAME, b"from the new socket")
    await asyncio.sleep(0.3)  # time for the server to read both sockets
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor")

    assert (status, base64.b64decode(chunk["data"])) == (200, b"from the new socket")
    assert record(new)["state"] == "attached" and os.path.islink(record(new)["path"])
    assert (await api("GET", "status"))[1]["tabs"][0]["tabId"] == "tab-1"


async def test_acc_serial_4_a_second_port_with_the_same_ids_gets_its_own_name(fake_tab):
    """ACC-SERIAL-4 the second port with one vendor and product id is `-2`, a port without ids is `tty-port`, and each keeps its name."""
    tab = await fake_tab()

    names = [(await tab.claim_serial(key))["name"] for key in
             (SERIAL_KEY, "s:2341:0043:1", "s:2341:0043:2", "s:port:0", "s:port:1", "s:2341:0043:1")]

    assert names == [SERIAL_NAME, f"{SERIAL_NAME}-2", f"{SERIAL_NAME}-3", "tty-port", "tty-port-2",
                     f"{SERIAL_NAME}-2"]
    assert record(tab, "tty-port")["vendorId"] is None
    assert (record(tab)["vendorId"], record(tab)["productId"]) == (0x2341, 0x0043)
    assert len({device["path"] for device in tab.devices["serial"]}) == 5


async def test_acc_sec_94_a_key_another_tab_holds_is_refused(fake_tab):
    """ACC-SEC-94 a claim on a key that another connected tab holds is refused and names the holder and the device."""
    first = await fake_tab("tab-1")
    second = await fake_tab("tab-2")
    assert (await first.claim_serial())["ok"]

    refused = await second.claim_serial()

    assert refused == {"type": "claimed", "key": SERIAL_KEY, "ok": False, "name": SERIAL_NAME,
                       "heldBy": "tab-1"}
    assert record(second)["tab"] == "tab-1"
    assert (await first.claim_serial())["ok"], "the holder itself may claim again"
    assert (await second.claim_usb())["ok"] and (await first.claim_usb())["heldBy"] == "tab-2"


async def test_acc_sec_94_no_takeover_until_the_other_tab_claims(fake_tab):
    """ACC-SEC-94 when the holder's tab closes the device is detached, and another tab holds it only after its own claim."""
    first, _ = await attach(fake_tab, "tab-1")
    second = await fake_tab("tab-2")

    await first.close()
    await second.until(lambda: record(second)["state"] == "detached")
    assert record(second)["tab"] is None

    assert (await second.claim_serial())["ok"]
    await second.until(lambda: record(second)["tab"] == "tab-2")


async def test_acc_sec_94_only_the_holder_reports_on_and_releases_a_device(fake_tab):
    """ACC-SEC-94 a tab that does not hold a device cannot detach it, forget it or change its record."""
    first, path = await attach(fake_tab, "tab-1")
    second = await fake_tab("tab-2")

    for reason in ("detach", "removed", "forget"):
        await second.release(SERIAL_NAME, reason)
    await second.send({"type": "serial-state", "name": SERIAL_NAME, "state": "error",
                       "settings": None, "signals": {}, "error": "not mine"})
    await second.send({"type": "stats", "name": SERIAL_NAME, "rx": 99, "tx": 99})
    await first.send({"type": "stats", "name": SERIAL_NAME, "rx": 7, "tx": 5})

    await first.until(lambda: record(first)["rx"] == 7)
    assert record(first) == {**record(first), "state": "attached", "tab": "tab-1", "portState": "open",
                             "tx": 5, "error": None}
    assert os.path.islink(path)


def test_acc_serial_127_the_device_directory_comes_from_the_setting_and_not_from_the_environment(monkeypatch):
    """ACC-SERIAL-127 the setting DeviceBridge.device_dir names the device directory; it is empty by default, also with JUPYTERLAB_DEVICE_DIR set."""
    monkeypatch.setenv("JUPYTERLAB_DEVICE_DIR", "/tmp/from-the-environment")
    assert DeviceBridge().device_dir == ""
    assert DeviceBridge().monitor_bytes == 262144

    settings = Config({"DeviceBridge": {"device_dir": "/tmp/from-the-settings", "monitor_bytes": 1024}})
    configured = DeviceBridge(config=settings)
    assert (configured.device_dir, configured.monitor_bytes) == ("/tmp/from-the-settings", 1024)


def test_acc_serial_127_a_server_without_the_setting_takes_the_default_directory(tmp_path, monkeypatch):
    """ACC-SERIAL-127 a server whose config names no device directory takes the one of default_device_dir, also with JUPYTERLAB_DEVICE_DIR set."""
    run_dir = str(tmp_path / "devices")
    monkeypatch.setattr(vserial, "RUN_DIR", run_dir)
    monkeypatch.setenv("JUPYTERLAB_DEVICE_DIR", "/tmp/from-the-environment")
    web_app = types.SimpleNamespace(settings={"base_url": "/"}, add_handlers=lambda *args: None)
    server = types.SimpleNamespace(config=Config(), log=logging.getLogger(__name__), web_app=web_app)

    _load_jupyter_server_extension(server)

    manager = web_app.settings[MANAGER_KEY]
    atexit.unregister(manager.close)
    assert manager.device_dir == run_dir


async def test_acc_sec_95_a_device_directory_that_is_a_symlink_refuses_the_claim(
        fake_tab, device_dir, tmp_path, caplog):
    """ACC-SEC-95 with a symlink as the device directory the server refuses the serial claim, logs why and makes no file."""
    target = tmp_path / "elsewhere"
    target.mkdir()
    os.symlink(target, device_dir)
    tab = await fake_tab()

    refused = await tab.claim_serial()

    assert refused == {"type": "claimed", "key": SERIAL_KEY, "ok": False}
    assert tab.devices["serial"] == [] and os.listdir(target) == []
    assert f"{device_dir} is not a directory" in caplog.text
    os.unlink(device_dir)
    assert (await tab.claim_serial())["ok"], "the directory is checked again at the next claim"


async def test_acc_serial_3_a_stopped_server_leaves_no_path_and_no_socket_behind(tmp_path, device_dir):
    """ACC-SERIAL-3 a Jupyter server that is stopped removes the paths and the shim sockets of its virtual serial devices."""
    with socket.socket() as free:
        free.bind(("127.0.0.1", 0))
        port = free.getsockname()[1]
    # JUPYTER_NO_CONFIG: the server loads this extension only, not the ones that the
    # environment enables. One of those, jupyter_lsp, looks for language servers in a
    # thread at server start, with `julia` and `Rscript` calls that have no timeout, and
    # Python ends only after that thread: with a `julia` that needs 40 s the server ended
    # 40 s after SIGTERM, and the wait below failed once on a CI runner.
    environment = dict(
        os.environ, PYTHONPATH=str(REPOSITORY), JUPYTER_RUNTIME_DIR=str(tmp_path / "runtime"),
        JUPYTER_CONFIG_DIR=str(tmp_path / "config"), JUPYTER_DATA_DIR=str(tmp_path / "data"),
        JUPYTER_NO_CONFIG="1")
    server = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "jupyter_server", "--no-browser", "--ServerApp.ip=127.0.0.1",
        f"--ServerApp.port={port}", "--ServerApp.port_retries=0", "--IdentityProvider.token=stop-test",
        f"--ServerApp.root_dir={tmp_path}", f"--DeviceBridge.device_dir={device_dir}",
        "--ServerApp.jpserver_extensions={'jupyterlab_device_bridge_extension': True}",
        env=environment, stderr=asyncio.subprocess.DEVNULL)
    try:
        url = f"ws://127.0.0.1:{port}/jupyterlab-device-bridge-extension/ws"
        deadline = time.monotonic() + 60
        while True:
            try:
                tab = await FakeTab.connect(url, {"Authorization": "token stop-test"})
                break
            except OSError:
                assert server.returncode is None and time.monotonic() < deadline, "the server did not start"
                await asyncio.sleep(0.1)
        assert (await tab.claim_serial())["ok"]
        path = os.path.join(device_dir, SERIAL_NAME)
        assert os.path.islink(path) and len(os.listdir(os.path.join(device_dir, ".shim"))) == 1

        server.terminate()
        assert await asyncio.wait_for(server.wait(), 30) == 0
    finally:
        if server.returncode is None:
            server.kill()
            await server.wait()

    assert os.listdir(device_dir) == [".shim"] and os.listdir(os.path.join(device_dir, ".shim")) == []


async def test_acc_sec_95_a_shim_directory_that_is_a_symlink_gets_no_socket(fake_tab, device_dir, tmp_path, caplog):
    """ACC-SEC-95 with a symlink as the shim directory the server makes no socket and logs why; the port attaches and works with its profile."""
    target = tmp_path / "elsewhere"
    target.mkdir()
    os.mkdir(device_dir, 0o700)
    os.symlink(target, os.path.join(device_dir, ".shim"))

    tab, path = await attach(fake_tab)

    assert os.listdir(target) == [] and os.path.islink(path)
    assert f"no shim socket for {SERIAL_NAME}" in caplog.text and "is not a directory" in caplog.text


def test_acc_serial_152_a_server_that_starts_removes_the_link_and_the_socket_a_killed_server_left(device_dir):
    """ACC-SERIAL-152 a server that starts on a device directory removes the symlink and the shim socket that a killed server left in it, and no regular file and no directory (DEF-SERIAL-5)."""
    link, left_socket, files = leave(device_dir)

    DeviceManager(device_dir, 1024, logging.getLogger(__name__)).close()

    assert not os.path.lexists(link) and not os.path.lexists(left_socket)
    assert all(os.path.isfile(file) for file in files)
    os.symlink("/dev/pts/left", link)
    DeviceManager(device_dir, 1024, logging.getLogger(__name__)).close()
    assert not os.path.lexists(link), "the first server unlocked the directory when it closed"


def test_acc_serial_152_a_server_that_starts_keeps_a_symlink_that_leads_to_no_pty_slave(device_dir, tmp_path):
    """ACC-SERIAL-152 a server that starts on a device directory removes the link a killed server left and keeps a symlink that leads to a file or to a directory, because the bridge did not make it."""
    link, _, _ = leave(device_dir)
    note = tmp_path / "note"
    note.write_text("the user's own file")
    kept = [os.path.join(device_dir, "note"), os.path.join(device_dir, "elsewhere")]
    os.symlink(note, kept[0])
    os.symlink(tmp_path, kept[1])

    DeviceManager(device_dir, 1024, logging.getLogger(__name__)).close()

    assert not os.path.lexists(link)
    assert [os.readlink(path) for path in kept] == [str(note), str(tmp_path)]


def test_acc_serial_152_a_server_that_starts_on_a_refused_directory_removes_nothing(device_dir, caplog):
    """ACC-SERIAL-152 a server that starts on a device directory that is a symlink removes nothing in the directory behind the symlink and logs why (DEF-SERIAL-5)."""
    link, left_socket, _ = leave(f"{device_dir}-elsewhere")
    os.symlink(f"{device_dir}-elsewhere", device_dir)

    DeviceManager(device_dir, 1024, logging.getLogger(__name__)).close()

    assert os.path.islink(link) and os.path.lexists(left_socket)
    assert f"{device_dir} is not a directory" in caplog.text


def test_acc_serial_152_a_server_that_starts_removes_nothing_behind_a_shim_directory_that_is_a_symlink(device_dir):
    """ACC-SERIAL-152 a server that starts on a device directory whose shim directory is a symlink keeps that symlink and removes no socket in the directory behind it (DEF-SERIAL-5)."""
    _, left_socket, _ = leave(f"{device_dir}-elsewhere")
    os.mkdir(device_dir, 0o700)
    os.symlink(os.path.dirname(left_socket), os.path.join(device_dir, ".shim"))

    DeviceManager(device_dir, 1024, logging.getLogger(__name__)).close()

    assert os.path.islink(os.path.join(device_dir, ".shim")) and os.path.lexists(left_socket)


async def test_acc_serial_152_a_directory_that_another_process_has_locked_is_left_as_it_is(device_dir, tool, caplog):
    """ACC-SERIAL-152 while another process holds the lock on the device directory, a server removes nothing from it, at its start and at its first claim, and logs one warning that names the setting DeviceBridge.device_dir (DEF-SERIAL-5)."""
    link, left_socket, _ = leave(device_dir)
    assert await line(await tool(LOCK, device_dir)) == b"locked\n"

    manager = DeviceManager(device_dir, 1024, logging.getLogger(__name__))
    try:
        tab = manager.connect("tab-1", True, True, lambda message: None)
        await manager.receive(tab, {"type": "claim", "kind": "serial", "key": SERIAL_KEY})
        assert os.path.islink(os.path.join(device_dir, SERIAL_NAME))
    finally:
        manager.close()

    assert os.path.islink(link) and stat.S_ISSOCK(os.lstat(left_socket).st_mode)
    assert [entry.levelname for entry in caplog.records
            if "DeviceBridge.device_dir" in entry.getMessage()] == ["WARNING"]


async def test_acc_serial_152_the_link_a_server_made_stays_at_its_next_claim(fake_tab, device_dir):
    """ACC-SERIAL-152 a server holds the lock on the device directory from its first claim, and its second claim removes neither the link nor the shim socket of the first (DEF-SERIAL-5)."""
    tab = await fake_tab()
    assert (await tab.claim_serial())["ok"]
    probe = os.open(device_dir, os.O_RDONLY)
    try:
        # Only an exclusive lock refuses a shared one.
        with pytest.raises(BlockingIOError):
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
    finally:
        os.close(probe)

    assert (await tab.claim_serial("s:2341:0043:1"))["ok"]

    assert all(os.path.islink(os.path.join(device_dir, name)) for name in (SERIAL_NAME, f"{SERIAL_NAME}-2"))
    assert len(os.listdir(os.path.join(device_dir, ".shim"))) == 2


# -------------------------------------------------------------------- bytes both ways


async def test_acc_serial_5_all_256_byte_values_reach_the_port_in_order(fake_tab, tool):
    """ACC-SERIAL-5 all 256 byte values a tool writes to the virtual device reach the port in order."""
    tab, path = await attach(fake_tab)
    tab.echo = False

    child = await tool(WRITE, path)
    assert await line(child) == b"written\n"

    await tab.until(lambda: len(tab.written(SERIAL_NAME)) >= 256)
    assert tab.written(SERIAL_NAME) == bytes(range(256))


async def test_acc_serial_6_all_256_byte_values_reach_the_tool_in_order(fake_tab, tool):
    """ACC-SERIAL-6 all 256 byte values the port sends reach the tool that holds the virtual device in order."""
    tab, path = await attach(fake_tab)
    child = await holding(tab, tool, READ, path, 256)

    await tab.port_sends(SERIAL_NAME, bytes(range(128)))
    await tab.port_sends(SERIAL_NAME, bytes(range(128, 256)))

    assert bytes.fromhex((await line(child)).decode()) == bytes(range(256))
    assert tab.got("data") == [], "bytes of the port went back to the port"


async def test_acc_serial_7_1_mib_echoed_by_the_port_returns_identical(fake_tab, tool):
    """ACC-SERIAL-7 1 MiB written by a tool and echoed by the port returns identical."""
    tab, path = await attach(fake_tab)

    child = await tool(ECHO_1_MIB, path)
    sent, received = (await line(child)).split()

    assert received == sent
    assert hashlib.sha256(tab.written(SERIAL_NAME)).hexdigest().encode() == sent
    assert all(len(event["data"]) <= 65536 for event in tab.got("data"))


async def test_acc_serial_13_bytes_sent_with_no_tool_are_not_delivered_to_the_next_tool(fake_tab, tool, api):
    """ACC-SERIAL-13 bytes the port sent while no tool held the device are not delivered to the next tool."""
    tab, path = await attach(fake_tab)
    await tab.port_sends(SERIAL_NAME, b"stale")
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)
    assert chunk["next"] == 5, "the server did not get the stale bytes before the tool opened"

    child = await holding(tab, tool, READ, path, 5)
    await tab.port_sends(SERIAL_NAME, b"fresh")

    assert bytes.fromhex((await line(child)).decode()) == b"fresh"


async def test_acc_mon_44_port_output_is_recorded_while_a_tool_holds_the_device(fake_tab, tool, api):
    """ACC-MON-44 port output reaches the tool that holds the device and the monitor buffer."""
    tab, path = await attach(fake_tab)
    await tab.port_sends(SERIAL_NAME, b"before the tool\n")
    child = await holding(tab, tool, READ, path, 9)

    await tab.port_sends(SERIAL_NAME, b"\x00\xffto both")

    assert bytes.fromhex((await line(child)).decode()) == b"\x00\xffto both"
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor")
    assert (status, chunk["start"], chunk["next"], chunk["dropped"]) == (200, 0, 25, False)
    assert base64.b64decode(chunk["data"]) == b"before the tool\n\x00\xffto both"


async def test_acc_serial_21_a_tool_that_writes_to_a_detached_device_is_not_blocked(fake_tab, tool):
    """ACC-SERIAL-21 bytes a tool writes to a detached device are dropped and the tool is not blocked."""
    tab, path = await attach(fake_tab)
    other = await fake_tab("tab-2")
    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")

    child = await tool(WRITE_64_KIB, path)

    assert await line(child) == b"written\n"
    await tab.until(lambda: record(tab)["holder"])
    await asyncio.sleep(0.2)
    assert tab.got("data") == [] and other.got("data") == []


# --------------------------------------------------------------- the tool and the port


async def test_acc_serial_11_the_record_shows_the_holder(fake_tab, tool, api):
    """ACC-SERIAL-11 when a tool opens the virtual device the device record shows its pid and program name within 1 s."""
    tab, path = await attach(fake_tab)
    assert record(tab)["holder"] is None

    child = await tool(HOLD, path)
    assert await line(child) == b"open\n"
    started = time.monotonic()
    holder = await tab.until(lambda: record(tab)["holder"], timeout=1.0)

    assert time.monotonic() - started < 1.0
    assert holder["pid"] == child.pid and holder["name"].startswith("python")
    status, table = await api("GET", "devices")
    assert table["serial"][0]["holder"] == holder


async def test_acc_serial_9_the_baud_rate_a_tool_sets_is_sent_to_the_port(fake_tab, tool):
    """ACC-SERIAL-9 the baud rate a tool sets on the virtual device is sent to the tab as the port's baud rate."""
    tab, path = await attach(fake_tab)
    child = await holding(tab, tool, BAUD_THEN_WRITE, path)
    assert configured(tab) == [], "115200 is what the port is open with already"

    child.stdin.write(b"\n")
    assert await line(child) == b"written\n"

    await tab.until(lambda: configured(tab))
    assert tab.got("serial-configure")[0]["settings"] == {
        "baudRate": 57600, "dataBits": 8, "parity": "none", "stopBits": 1}
    assert tab.got("serial-configure")[0]["name"] == SERIAL_NAME
    await tab.until(lambda: record(tab)["settings"]["baudRate"] == 57600)
    assert configured(tab) == [57600]


async def test_acc_serial_9_pyserial_as_the_tool(fake_tab, tool):
    """ACC-SERIAL-9 with pyserial as the tool its baud rates reach the port ahead of its bytes, a rate outside the standard table included, and the echo returns."""
    tab, path = await attach(fake_tab)

    child = await tool(PYSERIAL, path)

    assert await line(child) == b"ping 9600\n"
    assert await line(child) == b"pong 74880\n"
    assert await child.wait() == 0
    await tab.until(lambda: configured(tab) == [9600, 74880, 115200])
    order = [event["settings"]["baudRate"] if event["type"] == "serial-configure" else event["data"]
             for event in tab.events if event["type"] in ("serial-configure", "data")]
    assert order == [9600, b"ping", 74880, b"pong", 115200]


async def test_acc_serial_10_the_baud_change_reaches_the_tab_before_the_bytes(fake_tab, tool):
    """ACC-SERIAL-10 bytes a tool writes right after a baud change reach the tab after the `serial-configure` of that change."""
    tab, path = await attach(fake_tab)
    tab.echo = False
    child = await holding(tab, tool, BAUD_THEN_WRITE, path)
    before = len(tab.events)

    child.stdin.write(b"\n")
    assert await line(child) == b"written\n"
    await tab.until(lambda: tab.written(SERIAL_NAME) == b"after the baud change")

    order = [(event["type"], event.get("settings", {}).get("baudRate")) for event in tab.events[before:]
             if event["type"] in ("serial-configure", "data")]
    assert order[0] == ("serial-configure", 57600)
    assert [kind for kind, _ in order[1:]] == ["data"] * (len(order) - 1)


async def test_acc_serial_12_after_the_tool_closed_the_port_returns_to_the_profile_baud(fake_tab, tool, api):
    """ACC-SERIAL-12 when the tool closes the device the holder is cleared and the port returns to the profile's baud rate."""
    tab, path = await attach(fake_tab)
    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "arduino-isp"})
    assert (status, changed["settings"]["baudRate"]) == (200, 19200)
    child = await holding(tab, tool, BAUD_THEN_WRITE, path)
    child.stdin.write(b"\n")
    assert await line(child) == b"written\n"
    await tab.until(lambda: configured(tab) == [19200, 57600])

    await end(child)

    await tab.until(lambda: record(tab)["holder"] is None, timeout=1.0)
    await tab.until(lambda: configured(tab) == [19200, 57600, 19200])
    assert record(tab)["settings"]["baudRate"] == 19200

    again = await holding(tab, tool, HOLD, path)
    await asyncio.sleep(0.2)
    assert configured(tab) == [19200, 57600, 19200], "the next tool found the profile's baud rate on the device"
    await end(again)


async def test_acc_serial_12_after_a_tool_was_killed_in_exclusive_mode_the_next_tool_and_the_shim_work(
        fake_tab, tool):
    """ACC-SERIAL-12 a tool that set exclusive mode and was killed leaves the device usable: the next tool holds the same path, gets the port's bytes, and the shim socket follows the device."""
    tab, path = await attach(fake_tab)
    locked_socket = shim_socket(path)
    child = await holding(tab, tool, EXCLUSIVE, path)

    child.kill()
    await child.wait()
    await tab.until(lambda: record(tab)["holder"] is None)
    await tab.until(lambda: shim_socket(path) != locked_socket and os.path.exists(shim_socket(path)))

    assert not os.path.exists(locked_socket) and record(tab)["path"] == path
    again = await holding(tab, tool, READ, path, 5)
    assert record(tab)["holder"]["pid"] == again.pid
    await tab.port_sends(SERIAL_NAME, b"fresh")
    assert bytes.fromhex((await line(again)).decode()) == b"fresh"
    assert (await shim_says(path, b"S 1 0\n"))[0] == b"ok\n"
    assert [(event["dtr"], event["rts"]) for event in tab.got("serial-signals")] == [(True, False)]


async def test_acc_prof_26_pulse_dtr_is_run_when_a_tool_opens_the_device(fake_tab, tool, api):
    """ACC-PROF-26 with the arduino-upload profile a tool open sends `serial-action` pulse-dtr to the tab, once."""
    tab, path = await attach(fake_tab)
    await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "arduino-upload"})
    assert tab.got("serial-action") == []

    child = await holding(tab, tool, HOLD, path)
    await tab.until(lambda: tab.got("serial-action"))
    await end(child)
    await tab.until(lambda: record(tab)["holder"] is None)

    actions = tab.got("serial-action")
    assert [(action["name"], action["action"]) for action in actions] == [(SERIAL_NAME, "pulse-dtr")]
    assert isinstance(actions[0]["seq"], int)


async def test_acc_prof_26_the_action_follows_the_settings(fake_tab, tool, api):
    """ACC-PROF-26 on a tool open the tab gets the settings with the tool's baud first and the action after them."""
    tab, path = await attach(fake_tab)
    await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "esp-upload", "onOpen": "pulse-rts"})
    child = await tool(BAUD_THEN_WRITE, path)
    child.stdin.write(b"\n")
    assert await line(child) == b"open\n"
    assert await line(child) == b"written\n"

    await tab.until(lambda: tab.got("serial-action") and tab.written(SERIAL_NAME))

    order = [event["type"] for event in tab.events
             if event["type"] in ("serial-configure", "serial-action", "data")]
    assert order[:3] == ["serial-configure", "serial-action", "data"]
    assert tab.got("serial-action")[0]["action"] == "pulse-rts"


async def test_acc_prof_30_no_action_and_no_signal_with_on_open_none(fake_tab, tool, api):
    """ACC-PROF-30 with the monitor or the arduino-isp profile a tool open sends no action and no signal to the tab."""
    tab, path = await attach(fake_tab)
    for profile in ("monitor", "arduino-isp"):
        await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": profile})

        child = await tool(WRITE_64_KIB, path)
        assert await line(child) == b"written\n"
        await tab.until(lambda: record(tab)["holder"])
        await end(child)
        await tab.until(lambda: record(tab)["holder"] is None)

    assert len(tab.written(SERIAL_NAME)) == 2 * 65536
    assert tab.got("serial-action") == [] and tab.got("serial-signals") == []


async def test_acc_serial_16_a_removed_port_is_detached_and_keeps_its_path(fake_tab, api):
    """ACC-SERIAL-16 when the tab reports the port removed the device is detached with reason removed and its path stays."""
    tab, path = await attach(fake_tab)

    await tab.release(SERIAL_NAME, "removed")

    await tab.until(lambda: record(tab)["state"] == "detached")
    assert (record(tab)["error"], record(tab)["tab"], record(tab)["portState"]) == ("removed", None, "closed")
    assert os.path.islink(path) and stat.S_ISCHR(os.stat(path).st_mode)
    assert (await tab.claim_serial())["ok"]
    await tab.until(lambda: record(tab)["state"] == "attached")
    assert record(tab)["error"] is None


async def test_acc_serial_20_devices_of_a_closed_tab_are_detached_and_keep_their_paths(fake_tab, api):
    """ACC-SERIAL-20 when the owning tab disconnects its devices become detached and their paths stay."""
    tab, path = await attach(fake_tab)
    assert (await tab.claim_usb())["ok"]

    await tab.close()

    for _ in range(200):
        status, table = await api("GET", "devices")
        if table["serial"][0]["state"] == "detached":
            break
        await asyncio.sleep(0.01)
    assert (table["serial"][0]["state"], table["serial"][0]["tab"]) == ("detached", None)
    assert (table["usb"][0]["state"], table["usb"][0]["tab"]) == ("detached", None)
    assert os.path.islink(path) and stat.S_ISCHR(os.stat(path).st_mode)
    assert (await api("GET", "status"))[1]["tabs"] == []


async def test_acc_serial_19_forget_removes_the_device_and_its_path(fake_tab, api):
    """ACC-SERIAL-19 a release with reason forget removes the device, its path and its shim socket; a later grant gets the same name."""
    tab, path = await attach(fake_tab)
    shim_dir = os.path.join(os.path.dirname(path), ".shim")
    assert len(os.listdir(shim_dir)) == 1

    await tab.release(SERIAL_NAME, "forget")

    await tab.until(lambda: tab.devices["serial"] == [])
    assert not os.path.lexists(path) and os.listdir(shim_dir) == []
    assert (await api("GET", "serial", SERIAL_NAME, "monitor"))[0] == 404
    assert (await tab.claim_serial())["name"] == SERIAL_NAME
    assert os.path.islink(path)


async def test_acc_serial_17_the_browsers_reason_is_in_the_record(fake_tab):
    """ACC-SERIAL-17 the reason text of a port that the browser could not open is in the device record."""
    tab, _ = await attach(fake_tab)

    await tab.send({"type": "serial-state", "name": SERIAL_NAME, "state": "error", "settings": None,
                    "signals": {"dtr": True}, "error": "Failed to open serial port."})

    await tab.until(lambda: record(tab)["portState"] == "error")
    assert record(tab)["error"] == "Failed to open serial port."
    assert record(tab)["signals"] == {"dtr": True} and record(tab)["state"] == "attached"


async def test_acc_serial_17_a_port_that_is_not_open_is_asked_to_open_again(fake_tab, tool):
    """ACC-SERIAL-17 after the browser could not open the port, a tool open sends one `serial-configure` with the unchanged settings, and the record shows the port open with no reason (DEF-SERIAL-4)."""
    tab, path = await attach(fake_tab)
    settings = record(tab)["settings"]
    await tab.send({"type": "serial-state", "name": SERIAL_NAME, "state": "error", "settings": None,
                    "signals": {}, "error": "Failed to open serial port."})
    await tab.until(lambda: record(tab)["portState"] == "error")

    child = await tool(WRITE, path)
    assert await line(child) == b"written\n"
    await tab.until(lambda: len(tab.written(SERIAL_NAME)) >= 256)

    assert [event["settings"] for event in tab.got("serial-configure")] == [settings]
    await tab.until(lambda: record(tab)["portState"] == "open")
    assert record(tab)["error"] is None
    await end(child)


# ------------------------------------------------------------------- the shim socket


async def test_acc_shim_33_signal_lines_reach_the_tab_and_are_answered_after_its_ack(fake_tab):
    """ACC-SHIM-33 (socket side) the lines `S` and `B` of the shim reach the tab as `serial-signals` and are answered `ok`."""
    tab, path = await attach(fake_tab)
    mode = os.lstat(shim_socket(path)).st_mode
    assert stat.S_ISSOCK(mode) and stat.S_IMODE(mode) == 0o600

    answers = [await shim_says(path, text) for text in (b"S 1 0\n", b"S 0 1\n", b"B 1\n", b"B 0\n")]

    assert [answer for answer, _ in answers] == [b"ok\n"] * 4
    assert all(took < 0.9 for _, took in answers), "an acked event is answered before the 1 s limit"
    assert [{line: event[line] for line in ("dtr", "rts", "brk") if line in event}
            for event in tab.got("serial-signals")] == [
        {"dtr": True, "rts": False}, {"dtr": False, "rts": True}, {"brk": True}, {"brk": False}]
    assert tab.signals[SERIAL_NAME] == {"dtr": False, "rts": True, "brk": False}


async def test_acc_shim_33_the_answer_comes_after_1_s_when_the_tab_does_not_ack(fake_tab):
    """ACC-SHIM-33 (socket side) the shim is answered `ok` after 1 s when the tab does not ack, and at once when no tab holds the port or the line is not an event."""
    tab, path = await attach(fake_tab)
    tab.answers = False

    answer, took = await shim_says(path, b"S 1 1\n")
    assert answer == b"ok\n" and 0.95 < took < 3
    assert len(tab.got("serial-signals")) == 1

    answer, took = await shim_says(path, b"X nonsense\n")
    assert answer == b"ok\n" and took < 0.9
    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")
    answer, took = await shim_says(path, b"S 0 0\n")
    assert answer == b"ok\n" and took < 0.9
    assert len(tab.got("serial-signals")) == 1


async def test_acc_shim_33_a_line_for_a_forgotten_device_is_answered_and_changes_nothing(fake_tab, manager, caplog):
    """ACC-SHIM-33 (socket side) a line that a shim connection delivers after its device was forgotten is answered `ok`, raises nothing in the event loop and does not mark the device held; it guards change 1 of review round 1."""
    tab, path = await attach(fake_tab)
    device = manager.serial[SERIAL_NAME]
    reader, writer = await asyncio.open_unix_connection(shim_socket(path))
    writer.write(b"no event\n")
    assert await asyncio.wait_for(reader.readline(), 5) == b"ok\n", "the bridge serves this connection"

    await tab.release(SERIAL_NAME, "forget")
    await tab.until(lambda: tab.devices["serial"] == [])
    writer.write(b"S 1 0\n")
    answer = await asyncio.wait_for(reader.readline(), 5)
    writer.close()

    assert answer == b"ok\n"
    assert not device.pty.held
    assert [entry.getMessage() for entry in caplog.records if entry.levelno >= logging.ERROR] == []


async def test_acc_shim_34_the_tools_own_frame_format_reopens_the_port(fake_tab, tool):
    """ACC-SHIM-34 (socket side) the line `T 8 E 1` of a tool that holds the device reopens the port with even parity at the tool's baud rate, and the profile's format returns when the tool closes."""
    tab, path = await attach(fake_tab)
    child = await holding(tab, tool, BAUD_THEN_WRITE, path)
    child.stdin.write(b"\n")
    assert await line(child) == b"written\n"
    await tab.until(lambda: configured(tab) == [57600])

    assert (await shim_says(path, b"T 8 E 1\n"))[0] == b"ok\n"
    assert tab.got("serial-configure")[-1]["settings"] == {
        "baudRate": 57600, "dataBits": 8, "parity": "even", "stopBits": 1}
    assert (await shim_says(path, b"T 7 O 2\n"))[0] == b"ok\n"
    assert tab.got("serial-configure")[-1]["settings"] == {
        "baudRate": 57600, "dataBits": 7, "parity": "odd", "stopBits": 2}
    assert (await shim_says(path, b"T 5 N 1\n"))[0] == b"ok\n"
    assert tab.got("serial-configure")[-1]["settings"] == {
        "baudRate": 57600, "dataBits": 8, "parity": "none", "stopBits": 1}, "5 data bits stay the profile's 8"

    await end(child)
    await tab.until(lambda: record(tab)["holder"] is None)
    assert tab.got("serial-configure")[-1]["settings"] == {
        "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1}
    assert record(tab)["settings"]["parity"] == "none"


async def test_acc_shim_34_the_frame_format_is_applied_at_the_baud_rate_the_tool_just_set(fake_tab, tool):
    """ACC-SHIM-34 (socket side) a tool that sets its baud rate and its frame format in one call never has the port reopened at the baud rate it left."""
    tab, path = await attach(fake_tab)
    child = await holding(tab, tool, BAUD_AND_FRAME, path, shim_socket(path))

    child.stdin.write(b"\n")
    assert await line(child) == b"ok\n"
    await asyncio.sleep(0.2)

    # One reopen takes both. Two when the 20 ms poll read the baud rate before the line of
    # the shim arrived; then the first has the profile's parity still.
    settings = [event["settings"] for event in tab.got("serial-configure")]
    assert settings[-1] == {"baudRate": 57600, "dataBits": 8, "parity": "even", "stopBits": 1}
    assert len(settings) <= 2 and all(each["baudRate"] == 57600 for each in settings)
    await end(child)


async def test_acc_shim_34_a_frame_format_line_with_no_tool_on_the_device_changes_nothing(fake_tab, tool):
    """ACC-SHIM-34 (socket side) the line `T 8 E 1` while no tool holds the device is answered `ok` and sends no `serial-configure`, and the next tool gets the profile's parity (DEF-SHIM-3)."""
    tab, path = await attach(fake_tab)

    assert (await shim_says(path, b"T 8 E 1\n"))[0] == b"ok\n"
    child = await holding(tab, tool, HOLD, path)

    assert tab.got("serial-configure") == []
    assert record(tab)["settings"]["parity"] == "none"
    await end(child)


# ---------------------------------------------------------- the default serial settings

# The default serial settings of a lab, as its worker sends them with a claim.
DEFAULTS = {"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2, "onOpen": "pulse-dtr"}
OTHER_DEFAULTS = {"baudRate": 57600, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"}
SECOND_KEY = "s:2341:0043:1"
SECOND_NAME = f"{SERIAL_NAME}-2"


async def test_acc_prof_118_a_port_the_server_has_no_record_of_is_opened_with_the_default_settings(
        fake_tab, tool, manager, api):
    """ACC-PROF-118 the first claim of a serial key with `defaults` opens the port with them: the record has profile monitor and lists the values that differ from it as overrides, and the pty starts at that baud rate."""
    tab = await fake_tab()

    claimed = await tab.claim_serial(defaults=DEFAULTS)

    frame = {"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2}
    assert (claimed["ok"], claimed["profile"], claimed["settings"]) == (True, "monitor", frame)
    await tab.until(lambda: record(tab)["portState"] == "open")
    assert (record(tab)["profile"], record(tab)["overrides"], record(tab)["settings"]) == ("monitor", DEFAULTS, frame)
    assert manager.serial[SERIAL_NAME].pty.speed() == 9600

    # A tool that opens the device finds that baud rate on it, so the port is not opened
    # again, and the default action on open runs.
    child = await holding(tab, tool, HOLD, record(tab)["path"])
    await tab.until(lambda: tab.got("serial-action"))
    assert [action["action"] for action in tab.got("serial-action")] == ["pulse-dtr"]
    assert tab.got("serial-configure") == []
    await end(child)
    await tab.until(lambda: record(tab)["holder"] is None)

    # A profile chosen later replaces the default settings.
    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "arduino-isp"})
    assert (status, changed["overrides"]) == (200, {})
    assert changed["settings"] == {"baudRate": 19200, "dataBits": 8, "parity": "none", "stopBits": 1}


async def test_acc_prof_118_only_the_values_that_differ_from_profile_monitor_are_overrides(fake_tab):
    """ACC-PROF-118 a default that equals profile monitor is no override, and a claim without `defaults` gives the port profile monitor unchanged."""
    tab = await fake_tab()

    equal = await tab.claim_serial(defaults=OTHER_DEFAULTS)
    absent = await tab.claim_serial(SECOND_KEY)
    empty = await tab.claim_serial("s:2341:0043:2", defaults={})

    monitor = {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1}
    assert (equal["settings"], record(tab)["overrides"]) == ({**monitor, "baudRate": 57600}, {"baudRate": 57600})
    assert (absent["settings"], record(tab, SECOND_NAME)["overrides"]) == (monitor, {})
    assert (empty["settings"], record(tab, f"{SERIAL_NAME}-3")["overrides"]) == (monitor, {})
    assert {device["profile"] for device in tab.devices["serial"]} == {"monitor"}


async def test_acc_prof_119_a_later_claim_with_other_defaults_keeps_the_record(fake_tab):
    """ACC-PROF-119 a claim of a key that has a record ignores `defaults`: the record keeps its values over a claim of the holder, a detach, a reconnect and a claim with refused defaults; a key without a record gets the new values."""
    tab = await fake_tab()
    first = await tab.claim_serial(defaults=DEFAULTS)

    held = await tab.claim_serial(defaults=OTHER_DEFAULTS)
    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")
    detached = await tab.claim_serial(defaults=OTHER_DEFAULTS)
    await tab.close()
    again = await fake_tab()
    reconnected = await again.claim_serial(defaults=OTHER_DEFAULTS)
    refused = await again.claim_serial(defaults={"baudRate": 0})

    for later in (held, detached, reconnected, refused):
        assert later["ok"], "a claim of a key that has a record is granted whatever its defaults are"
        assert (later["settings"], later["sid"]) == (first["settings"], first["sid"])
    assert (record(again)["overrides"], record(again)["settings"]) == (DEFAULTS, first["settings"])

    # A port added after the change gets the new values.
    second = await again.claim_serial(SECOND_KEY, defaults=OTHER_DEFAULTS)
    assert second["settings"]["baudRate"] == 57600
    assert record(again, SECOND_NAME)["overrides"] == {"baudRate": 57600}
    assert record(again)["overrides"] == DEFAULTS

    # A forgotten port has no record: when it is added again it gets the values of that claim.
    await again.release(SERIAL_NAME, "forget")
    await again.until(lambda: all(device["name"] != SERIAL_NAME for device in again.devices["serial"]))
    added = await again.claim_serial(defaults=OTHER_DEFAULTS)
    assert (added["name"], added["settings"]["baudRate"]) == (SERIAL_NAME, 57600)
    assert record(again)["overrides"] == {"baudRate": 57600}


@pytest.mark.parametrize("defaults", [
    {"baudRate": 0},
    {"parity": "mark"},
    # DEF-SERIAL-12: a baud rate the 32-bit speed of the pty cannot hold.
    {"baudRate": 4294967296},
    {"profile": "arduino-isp"},
    {"speed": 9600},
    {"dataBits": 9},
    {"stopBits": "1"},
    {"onOpen": "pulse-cts"},
    {**DEFAULTS, "profile": "monitor"},
    {**DEFAULTS, "flowControl": "none"},
    [9600],
    "9600",
    None,
])
async def test_acc_prof_120_a_claim_with_refused_defaults_is_refused_and_makes_no_record(
        fake_tab, api, device_dir, caplog, defaults):
    """ACC-PROF-120 a first claim whose `defaults` hold an unknown field, a profile id or a value outside the profile choices, or are no object, is refused: no record, no name for the key, no device directory, and the reason in the log."""
    tab = await fake_tab()

    refused = await tab.claim_serial(SECOND_KEY, defaults=defaults)

    assert refused == {"type": "claimed", "key": SECOND_KEY, "ok": False}
    assert (await api("GET", "devices")) == (200, {"serial": [], "usb": []})
    assert not os.path.lexists(device_dir), "nothing was made for the refused claim"
    assert f"the claim of {SECOND_KEY!r} is refused" in caplog.text
    # The refused key has no name: the next port takes the first name of these ids.
    assert (await tab.claim_serial())["name"] == SERIAL_NAME
    assert (await tab.claim_serial(SECOND_KEY, defaults=DEFAULTS))["name"] == SECOND_NAME


# ------------------------------------------------------------------------------- runs

# Says that it runs, then waits for a line on stdin. SIGHUP ends it, as it ends most tools.
WAIT = """
import sys
print("ready", flush=True)
sys.stdin.readline()
"""

# Ignores SIGHUP, as a tool started under nohup does, and says when one arrived.
IGNORE_HUP = """
import signal
signal.signal(signal.SIGHUP, lambda *_: print("hup", flush=True))
print("ready", flush=True)
while True:
    signal.pause()
"""

# Starts a child of its own, which is in its process group, and prints the id of that child.
WITH_CHILD = """
import subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
print(child.pid, flush=True)
sys.stdin.readline()
"""

# A terminal session as the lab starts one for a device shell. This process leads the session,
# with the terminal of argv[1] as its controlling terminal, and the shell of argv[2:] is its
# child, as a device shell is the child of the script that launches it. A shell that led the
# session itself would prove less: when a session leader ends, the kernel sends SIGHUP to the
# foreground tool, whatever ended the leader. Prints the process id of the shell, then how the
# shell ended: its exit status, or the negative number of the signal that ended it.
SESSION = """
import os, subprocess, sys
os.setsid()
# The first terminal that a session leader opens becomes its controlling terminal.
terminal = os.open(sys.argv[1], os.O_RDWR)
shell = subprocess.Popen(sys.argv[2:], stdin=terminal, stdout=terminal, stderr=terminal)
print(shell.pid, flush=True)
print(shell.wait(), flush=True)
"""

# No process has this id: it is above the largest process id of Linux, 4194304.
NO_PROCESS = 99999999
AVRDUDE = ["/usr/bin/avrdude", "-c", "arduino", "-P", "/run/devices/tty-2341-0043"]
AVRDUDE_TEXT = "/usr/bin/avrdude -c arduino -P /run/devices/tty-2341-0043"


async def running(tool, script=WAIT):
    """A child process that said it runs."""
    child = await tool(script)
    assert await line(child) == b"ready\n"
    return child


def state(pid):
    """The state letter of a process in /proc/<pid>/stat, for example S, R or Z; None when it has no entry."""
    try:
        with open(f"/proc/{pid}/stat") as entry:
            return entry.read().rpartition(")")[2].split()[0]
    except OSError:
        return None


def child_running(pid, program):
    """The id of a child of this process that runs this program; None while it has no such child."""
    for candidate in os.listdir("/proc"):
        if candidate.isdigit():
            try:
                with open(f"/proc/{candidate}/stat") as entry:
                    name, _, fields = entry.read().partition("(")[2].rpartition(")")
            except OSError:
                continue  # the process ended meanwhile
            if name == program and fields.split()[1] == str(pid):
                return int(candidate)
    return None


def foreign_process():
    """The id of a process that another user owns; None when the user of the tests owns every process it sees."""
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                if os.stat(f"/proc/{entry}").st_uid != os.getuid():
                    return int(entry)
            except OSError:
                continue  # the process ended meanwhile
    return None


def another_process_takes(monkeypatch, pid):
    """From now on the server reads another start time for this process id.

    That is what it reads after the kernel gave the id of an ended process to a new one,
    which a test cannot make the kernel do.
    """
    started = manager_module._started
    monkeypatch.setattr(manager_module, "_started",
                        lambda asked: started(asked) + 1 if asked == pid else started(asked))


async def pong(tab):
    """Returns when the tab got everything the server sent before this call."""
    seen = len(tab.got("pong"))
    await tab.send({"type": "ping", "t": 0})
    await tab.until(lambda: len(tab.got("pong")) > seen)


async def test_acc_shim_129_a_registered_run_is_listed_until_its_process_ends(api, fake_tab, tool):
    """ACC-SHIM-129 `GET runs` and the message `runs` hold a registered run while its process lives, a tab that connects gets the list after its welcome, and the run leaves both within 2 s after its process ended."""
    tab = await fake_tab()
    assert [event["type"] for event in tab.events[:4]] == ["welcome", "devices", "requests", "runs"]
    assert tab.runs == {"type": "runs", "running": []}
    assert (await api("GET", "runs")) == (200, {"runs": []})
    child = await running(tool)

    status, run = await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE, "device": SERIAL_NAME})

    assert (status, run) == (200, {"pid": child.pid, "program": "avrdude", "command": AVRDUDE_TEXT,
                                   "device": SERIAL_NAME})
    await tab.until(lambda: tab.runs["running"])
    assert tab.runs == {"type": "runs", "running": [run]}
    late = await fake_tab("tab-2")
    assert late.runs == tab.runs, "a tab that connects later gets the live runs"
    # The watch looks at the process once a second and keeps a run whose process lives.
    await asyncio.sleep(1.5)
    assert (await api("GET", "runs")) == (200, {"runs": [run]})
    assert len(tab.got("runs")) == 2, "the list is sent on a change only"

    started = time.monotonic()
    await end(child)
    await tab.until(lambda: tab.runs["running"] == [], timeout=2)
    assert time.monotonic() - started < 2
    assert (await api("GET", "runs")) == (200, {"runs": []})
    await late.until(lambda: late.runs["running"] == [])


async def test_acc_shim_129_the_record_of_a_run_and_a_second_registration_of_its_process_id(api, fake_tab, tool):
    """ACC-SHIM-129 the record of a run has the base name of the first word as program, the words joined and cut after 200 characters as command, and null as device when the run named none; a second registration of the process id replaces the record."""
    tab = await fake_tab()
    child = await running(tool)
    start = "./tools/esptool.py --port /run/devices/tty-10c4-ea60 write-flash 0x0 "

    status, first = await api("POST", "runs", body={"pid": child.pid, "command": [*start.split(), "f" * 300]})

    assert status == 200
    assert first == {"pid": child.pid, "program": "esptool.py", "command": start + "f" * (200 - len(start)),
                     "device": None}

    status, second = await api("POST", "runs", body={"pid": child.pid, "command": ["sh"], "device": None})

    assert (status, second) == (200, {"pid": child.pid, "program": "sh", "command": "sh", "device": None})
    assert (await api("GET", "runs")) == (200, {"runs": [second]})
    await tab.until(lambda: tab.runs["running"] == [second])
    await end(child)


async def test_acc_shim_129_a_dead_process_id_is_refused(api, fake_tab, tool):
    """ACC-SHIM-129 the registration of a process id whose process has ended is refused with 400, lists nothing and sends no list."""
    tab = await fake_tab()
    child = await running(tool)
    await end(child)

    status, document = await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE})

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith("pid: ")
    assert (await api("GET", "runs")) == (200, {"runs": []})
    await pong(tab)
    assert len(tab.got("runs")) == 1, "the refused run changed no list"


# What a registration must not be: the body for the process id of a live child, and the field it is refused for.
BAD_RUNS = {
    "no pid": (lambda pid: {"command": AVRDUDE}, "pid"),
    "the pid as a text": (lambda pid: {"pid": str(pid), "command": AVRDUDE}, "pid"),
    "the pid as a fraction": (lambda pid: {"pid": pid + 0.5, "command": AVRDUDE}, "pid"),
    "true as pid": (lambda pid: {"pid": True, "command": AVRDUDE}, "pid"),
    "pid 0": (lambda pid: {"pid": 0, "command": AVRDUDE}, "pid"),
    "the negative pid, which names a process group": (lambda pid: {"pid": -pid, "command": AVRDUDE}, "pid"),
    "a pid that no process has": (lambda pid: {"pid": NO_PROCESS, "command": AVRDUDE}, "pid"),
    "no command": (lambda pid: {"pid": pid}, "command"),
    "a command without a word": (lambda pid: {"pid": pid, "command": []}, "command"),
    "the command as one text": (lambda pid: {"pid": pid, "command": AVRDUDE_TEXT}, "command"),
    "a word that is a number": (lambda pid: {"pid": pid, "command": ["avrdude", "-b", 115200]}, "command"),
    "a device that is a number": (lambda pid: {"pid": pid, "command": AVRDUDE, "device": 5}, "device"),
}


@pytest.mark.parametrize("body, field", BAD_RUNS.values(), ids=BAD_RUNS)
async def test_acc_shim_129_a_malformed_registration_is_refused(body, field, api, tool):
    """ACC-SHIM-129 a registration whose pid is no id of a live process, whose command is no list of 1 or more texts, or whose device is no text is refused with 400 and names the field."""
    child = await running(tool)

    status, document = await api("POST", "runs", body=body(child.pid))

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith(f"{field}: ")
    assert (await api("GET", "runs")) == (200, {"runs": []})
    await end(child)


async def test_acc_shim_129_a_process_that_does_not_belong_to_the_servers_user_is_refused(api, tool, monkeypatch):
    """ACC-SHIM-129 the registration of a live process is refused with 400 when the owner of /proc/<pid> is not the server's user.

    The user of the tests can own every process of the machine, pid 1 included, so the
    test gives the server another user id for the one call. The next test asks with a
    process that another user owns, where one exists.
    """
    child = await running(tool)
    body = {"pid": child.pid, "command": AVRDUDE}
    own = os.getuid()

    with monkeypatch.context() as other_user:
        other_user.setattr(os, "getuid", lambda: own + 1)
        status, document = await api("POST", "runs", body=body)

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith("pid: ")
    assert (await api("GET", "runs")) == (200, {"runs": []})
    assert (await api("POST", "runs", body=body))[0] == 200, "the server takes the same process as its own user"
    await end(child)


async def test_acc_shim_129_a_process_that_another_user_owns_is_refused(api):
    """ACC-SHIM-129 the registration of a process that another user owns is refused with 400."""
    pid = foreign_process()
    if pid is None:
        pytest.skip("the user of the tests owns every process of this machine, pid 1 included")

    status, document = await api("POST", "runs", body={"pid": pid, "command": AVRDUDE})

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith("pid: ")
    assert (await api("GET", "runs")) == (200, {"runs": []})


async def test_acc_shim_129_a_run_whose_ended_process_nobody_waited_for_leaves_the_list(api, fake_tab):
    """ACC-SHIM-129 a run leaves the list within 2 s after its process ended also while that process is a zombie: its parent has not waited for it, so /proc keeps its entry with the same start time."""
    tab = await fake_tab()
    # Not an asyncio child: asyncio waits for its children at once, and this parent must not.
    child = subprocess.Popen([sys.executable, "-c", WAIT], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        assert await asyncio.to_thread(child.stdout.readline) == b"ready\n"
        assert (await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE}))[0] == 200
        await tab.until(lambda: tab.runs["running"])

        started = time.monotonic()
        child.stdin.close()
        await tab.until(lambda: tab.runs["running"] == [], timeout=2)

        assert time.monotonic() - started < 2
        assert state(child.pid) == "Z", "the process was a zombie when its run left the list"
        assert (await api("GET", "runs")) == (200, {"runs": []})
    finally:
        child.kill()
        child.wait()
        child.stdout.close()


async def test_acc_shim_129_the_watch_runs_only_while_a_run_is_registered_and_ends_with_the_manager(
        api, manager, tool, monkeypatch):
    """ACC-SHIM-129 the server looks at the processes of the runs only while a run is registered, and never after `DeviceManager.close()`."""
    looks = []
    look = manager._check_runs
    monkeypatch.setattr(manager, "_check_runs", lambda: (looks.append(time.monotonic()), look()))
    manager.run_watch_interval = 0.05

    async def looked(count):
        """Returns when the server looked at the runs `count` times more."""
        wanted = len(looks) + count
        deadline = time.monotonic() + 5
        while len(looks) < wanted:
            assert time.monotonic() < deadline, f"the server looked {len(looks)} times, not {wanted}"
            await asyncio.sleep(0.01)

    async def quiet():
        """Whether the server does not look at the runs for 6 times the interval."""
        before = len(looks)
        await asyncio.sleep(0.3)
        return len(looks) == before

    assert await quiet(), "no run is registered yet"
    child = await running(tool)
    assert (await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE}))[0] == 200
    await looked(3)

    await end(child)
    await looked(1)
    assert manager.runs() == [] and await quiet(), "the last run has ended"

    child = await running(tool)
    assert (await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE}))[0] == 200
    await looked(3)
    manager.close()
    assert manager.runs() == [] and await quiet(), "the manager is closed"
    await end(child)


async def test_acc_shim_157_stop_ends_a_run_with_sighup(api, fake_tab, tool):
    """ACC-SHIM-157 `DELETE runs/<pid>` answers 204 and sends SIGHUP to the process of the run, and the run leaves the list when that process has ended."""
    tab = await fake_tab()
    child = await running(tool)
    assert (await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE}))[0] == 200

    stopped = await api("DELETE", "runs", str(child.pid))

    assert stopped == (204, None)
    # Within 2 s it is the SIGHUP that ended the process: the SIGKILL comes after 3 s.
    assert await asyncio.wait_for(child.wait(), 2) == -signal.SIGHUP
    await tab.until(lambda: tab.runs["running"] == [], timeout=2)
    assert (await api("GET", "runs")) == (200, {"runs": []})


async def test_acc_shim_157_a_run_that_ignores_sighup_gets_sigkill_3_s_later(api, fake_tab, tool):
    """ACC-SHIM-157 a run whose process ignores SIGHUP stays listed and gets SIGKILL 3 s after the stop, and the route answers 204 at once."""
    tab = await fake_tab()
    child = await running(tool, IGNORE_HUP)
    status, run = await api("POST", "runs", body={"pid": child.pid, "command": ["bash"]})
    assert status == 200

    started = time.monotonic()
    stopped = await api("DELETE", "runs", str(child.pid))
    answered = time.monotonic() - started

    assert stopped == (204, None) and answered < 1
    assert await line(child) == b"hup\n", "the process got SIGHUP"
    await asyncio.sleep(2)
    assert child.returncode is None, "no SIGKILL before the 3 s are over"
    assert (await api("GET", "runs")) == (200, {"runs": [run]}), "a stopped run that still lives stays listed"
    assert await asyncio.wait_for(child.wait(), 5) == -signal.SIGKILL
    assert 3 <= time.monotonic() - started < 6
    await tab.until(lambda: tab.runs["running"] == [], timeout=2)


async def test_acc_shim_157_an_unknown_process_id_is_404(api, tool):
    """ACC-SHIM-157 `DELETE runs/<pid>` of a process id that is no registered run is answered 404 with the code unknown-run, and a live process that is no run gets no signal."""
    child = await running(tool)

    for pid in (NO_PROCESS, child.pid, "abc", "0", "-1", f"-{child.pid}"):
        status, document = await api("DELETE", "runs", str(pid))
        assert (status, document["error"]["code"]) == (404, "unknown-run"), pid
        assert str(pid) in document["error"]["message"]

    await asyncio.sleep(0.3)
    assert child.returncode is None, "the process that is no run got no signal"
    await end(child)


async def test_acc_shim_157_a_process_id_that_another_process_took_is_not_signalled(
        api, fake_tab, tool, manager, monkeypatch):
    """ACC-SHIM-157 a stop of a run whose process id now belongs to a process with another start time sends no signal: the run is ended, its list is sent, and the answer is 404."""
    manager.run_watch_interval, manager.run_kill_delay = 60, 0.2  # the watch does not end the run first
    tab = await fake_tab()
    child = await running(tool)
    assert (await api("POST", "runs", body={"pid": child.pid, "command": AVRDUDE}))[0] == 200
    await tab.until(lambda: tab.runs["running"])
    another_process_takes(monkeypatch, child.pid)

    status, document = await api("DELETE", "runs", str(child.pid))
    await asyncio.sleep(0.6)

    assert child.returncode is None, "neither SIGHUP nor SIGKILL reached the process that has the id now"
    assert (status, document["error"]["code"]) == (404, "unknown-run")
    await tab.until(lambda: tab.runs["running"] == [])
    await end(child)


async def test_acc_shim_157_no_sigkill_for_a_process_id_that_another_process_took_after_the_sighup(
        api, tool, manager, monkeypatch):
    """ACC-SHIM-157 the SIGKILL is sent only when the process that got the SIGHUP still lives: a process with another start time that has the id by then is not signalled."""
    manager.run_watch_interval, manager.run_kill_delay = 60, 1
    child = await running(tool, IGNORE_HUP)
    assert (await api("POST", "runs", body={"pid": child.pid, "command": ["bash"]}))[0] == 200

    assert (await api("DELETE", "runs", str(child.pid)))[0] == 204
    assert await line(child) == b"hup\n"
    another_process_takes(monkeypatch, child.pid)
    await asyncio.sleep(1.5)

    assert child.returncode is None, "no SIGKILL for the process that has the id now"


async def test_acc_shim_157_stop_signals_the_process_of_the_run_and_not_its_process_group(api):
    """ACC-SHIM-157 the stop signal goes to the process of the run only: a child of that process in the same process group lives on."""
    # A session of its own, so that the process group of the run is not the one of the tests.
    run = await asyncio.create_subprocess_exec(
        sys.executable, "-c", WITH_CHILD, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        start_new_session=True)
    grandchild = int(await line(run))
    try:
        assert os.getpgid(grandchild) == os.getpgid(run.pid) != os.getpgid(0)
        assert (await api("POST", "runs", body={"pid": run.pid, "command": ["bash"]}))[0] == 200

        assert (await api("DELETE", "runs", str(run.pid)))[0] == 204

        assert await asyncio.wait_for(run.wait(), 2) == -signal.SIGHUP
        await asyncio.sleep(0.3)
        assert state(grandchild) in ("S", "R"), "the child of the run got no signal"
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.kill(grandchild, signal.SIGKILL)
        if run.returncode is None:
            run.kill()
            await run.wait()


# The interactive shells of the test below. Neither reads a start file, and fish keeps no history.
SHELLS = [
    pytest.param(["bash", "--norc", "-i"], id="bash"),
    pytest.param(["fish", "--no-config", "--private", "-i"], id="fish",
                 marks=pytest.mark.skipif(shutil.which("fish") is None, reason="fish is not installed")),
]


@pytest.mark.parametrize("shell", SHELLS)
async def test_acc_shim_157_stop_ends_an_interactive_shell_together_with_its_foreground_tool(
        shell, api, tool, tmp_path, monkeypatch):
    """ACC-SHIM-157 the stop of a run that is an interactive shell on a terminal, with a tool in its foreground, ends the shell and the tool within 1 s, and it is not the SIGKILL that ends the shell: bash ends by the SIGHUP itself."""
    monkeypatch.setenv("HOME", str(tmp_path))  # bash writes its history there
    keyboard, terminal = pty.openpty()
    shell_pid = tool_pid = None
    try:
        session = await tool(SESSION, os.ttyname(terminal), *shell)
        shell_pid = int(await line(session))
        os.write(keyboard, b"sleep 60\n")
        deadline = time.monotonic() + 20
        while (tool_pid := child_running(shell_pid, "sleep")) is None:
            assert time.monotonic() < deadline, "the shell did not start the tool"
            await asyncio.sleep(0.01)
        assert (await api("POST", "runs", body={"pid": shell_pid, "command": ["jupyterlab-device", "shell"]}))[0] == 200

        stopped = time.monotonic()
        assert (await api("DELETE", "runs", str(shell_pid))) == (204, None)

        # State Z: the process has ended, and the process that inherited it has not waited for it yet.
        while living := [name for name, pid in (("the shell", shell_pid), ("the tool", tool_pid))
                         if state(pid) not in (None, "Z")]:
            assert time.monotonic() - stopped < 1, f"1 s after the stop these still run: {', '.join(living)}"
            await asyncio.sleep(0.01)
        ended = int(await line(session))
        assert ended != -signal.SIGKILL, "the shell ended before the SIGKILL of the stop"
        if shell[0] == "bash":
            assert ended == -signal.SIGHUP, "bash ends by the signal itself"
    finally:
        for pid in (tool_pid, shell_pid):
            if pid:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)
        os.close(keyboard)
        os.close(terminal)
