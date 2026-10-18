"""Tests of the preload shim: the library compiled from `shim/devshim.c`, loaded into a small Python tool.

The tool runs under `jupyterlab-device run`, on a virtual serial device of the test
server whose port is the browser tab double. Where a pty alone could give the same
result, the test first runs the tool without the shim.
"""

import ast
import asyncio
import errno
import os
import shutil
import sys

import pytest

from jupyterlab_device_bridge_extension import shim_build
from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_NAME

from .test_cli import cli_run, lab  # noqa: F401 - fixtures
from .test_client import REPOSITORY, attach_serial
from .test_manager import record

PIPE = asyncio.subprocess.PIPE

# The break calls of Linux, which Python's termios module does not name.
BREAK_CALLS = "TIOCSBRK, TIOCCBRK = 0x5427, 0x5428"

# Sets and clears DTR and RTS with the three modem line calls and reads the lines back
# after each call; then sets and clears the break. Prints what it read back.
MODEM_LINES = f"""
import fcntl, os, struct, sys, termios
{BREAK_CALLS}
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
read = []
for call, bits in ((termios.TIOCMBIS, termios.TIOCM_DTR), (termios.TIOCMBIS, termios.TIOCM_RTS),
                   (termios.TIOCMBIC, termios.TIOCM_DTR), (termios.TIOCMSET, 0),
                   (termios.TIOCMSET, termios.TIOCM_DTR | termios.TIOCM_RTS),
                   (termios.TIOCMBIC, termios.TIOCM_RTS)):
    fcntl.ioctl(fd, call, struct.pack("i", bits))
    now, = struct.unpack("i", fcntl.ioctl(fd, termios.TIOCMGET, bytes(4)))
    read.append((bool(now & termios.TIOCM_DTR), bool(now & termios.TIOCM_RTS)))
fcntl.ioctl(fd, TIOCSBRK)
fcntl.ioctl(fd, TIOCCBRK)
print(read)
"""
# Sets DTR once and prints the seconds that the call took.
TIMED_CALL = """
import fcntl, os, struct, sys, termios, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
started = time.monotonic()
fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("i", termios.TIOCM_DTR))
print(time.monotonic() - started)
"""

MODEM_LINES_ORDER = [(True, False), (True, True), (False, True), (False, False), (True, True), (True, False)]

# For each line on stdin, a frame format such as 8E1: sets it with tcsetattr, at the baud
# rate argv[2] when that is given and else at the rate the device has, and prints the
# format that tcgetattr then reports, or `refused` when the call fails.
SET_FRAME = """
import os, sys, termios
FRAME = termios.CSIZE | termios.PARENB | termios.PARODD | termios.CSTOPB
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
print("open", flush=True)
for line in sys.stdin:
    bits, parity, stop = line.strip()
    settings = termios.tcgetattr(fd)
    settings[2] = (settings[2] & ~FRAME | (termios.CS7 if bits == "7" else termios.CS8)
                   | (parity != "N") * termios.PARENB | (parity == "O") * termios.PARODD
                   | (stop == "2") * termios.CSTOPB)
    if len(sys.argv) > 2:
        settings[4] = settings[5] = getattr(termios, "B" + sys.argv[2])
    try:
        termios.tcsetattr(fd, termios.TCSANOW, settings)
    except termios.error:
        print("refused", flush=True)
        continue
    cflag = termios.tcgetattr(fd)[2]
    print(("7" if cflag & termios.CSIZE == termios.CS7 else "8")
          + ("N" if not cflag & termios.PARENB else "O" if cflag & termios.PARODD else "E")
          + ("2" if cflag & termios.CSTOPB else "1"), flush=True)
"""

# pyserial as the tool, the library under esptool and stm32loader: opens 8E1 at the baud
# rate the device has, which sets DTR and RTS, sets its settings a second time (a new
# timeout does that), then moves the two lines.
PYSERIAL = """
import sys
import serial
port = serial.Serial(sys.argv[1], 115200, parity=serial.PARITY_EVEN)
port.timeout = 2
port.dtr = False
port.rts = False
port.dtr = True
print("done", flush=True)
sys.stdin.readline()
"""
PYSERIAL_ORDER = [(True, False), (True, True), (False, True), (False, False), (True, False)]

# For each line on stdin: opens the device, sets 8E1 and closes it without a write, then
# prints `closed`.
OPEN_SET_CLOSE = """
import os, sys, termios
for line in sys.stdin:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
    settings = termios.tcgetattr(fd)
    settings[2] |= termios.PARENB
    termios.tcsetattr(fd, termios.TCSANOW, settings)
    os.close(fd)
    print("closed", flush=True)
"""

# Terminal calls on descriptors that are no bridge device, a pty of the tool's own and a
# regular file (argv[1]): the first line printed. One call on the bridge device (argv[2]):
# the second line.
OTHER_DESCRIPTORS = f"""
import fcntl, os, struct, sys, termios
{BREAK_CALLS}

def attempt(call, *args):
    try:
        return call(*args)
    except (OSError, termios.error) as error:
        return ("refused", error.args[0])

def calls(fd):
    before = attempt(termios.tcgetattr, fd)
    parity = None
    if isinstance(before, list):
        wanted = list(before)
        wanted[2] |= termios.PARENB
        parity = (attempt(termios.tcsetattr, fd, termios.TCSANOW, wanted), attempt(termios.tcgetattr, fd))
    return (before, parity,
            attempt(fcntl.ioctl, fd, termios.TIOCMGET, bytes(4)),
            attempt(fcntl.ioctl, fd, termios.TIOCMBIS, struct.pack("i", termios.TIOCM_DTR)),
            attempt(fcntl.ioctl, fd, TIOCSBRK),
            attempt(fcntl.ioctl, fd, TIOCCBRK))

master, slave = os.openpty()
print((calls(slave), calls(os.open(sys.argv[1], os.O_RDWR))))
print(attempt(fcntl.ioctl, os.open(sys.argv[2], os.O_RDWR | os.O_NOCTTY), termios.TIOCMGET, bytes(4)))
"""


def settings(frame, baud=115200):
    """The serial settings of a frame format in the usual short form, for example `8E1`."""
    bits, parity, stop = frame
    return {"baudRate": baud, "dataBits": int(bits), "stopBits": int(stop),
            "parity": {"N": "none", "E": "even", "O": "odd"}[parity]}


def lines(tab):
    """`(dtr, rts)` of every `serial-signals` with the two modem lines that a tab got, in order."""
    return [(event["dtr"], event["rts"]) for event in tab.got("serial-signals") if "dtr" in event]


async def answer(child, line=None):
    """Write a line to a tool's stdin, when one is given, and return the next line the tool prints."""
    if line:
        child.stdin.write(f"{line}\n".encode())
    return (await asyncio.wait_for(child.stdout.readline(), 20)).decode().strip()


async def holds(tab, child):
    """Wait until a tool has the device open and the bridge shows a holder."""
    assert await answer(child) == "open"
    await tab.until(lambda: record(tab)["holder"])
    return child


async def ends(tab, child):
    """Close a tool's stdin, which ends it, and wait until the port is back at its own settings."""
    child.stdin.close()
    assert await asyncio.wait_for(child.wait(), 20) == 0
    await tab.until(lambda: record(tab)["holder"] is None and tab.settings[SERIAL_NAME] == settings("8N1"))


def configured(tab):
    """The settings of every `serial-configure` a tab got, in order."""
    return [event["settings"] for event in tab.got("serial-configure")]


def counting_compiler(directory):
    """Put a `cc` in `directory` that notes each call in the file `calls` beside it and runs the real compiler."""
    directory.mkdir()
    calls = directory / "calls"
    wrapper = directory / "cc"
    wrapper.write_text(f'#!/bin/sh\necho call >> "{calls}"\nexec "{shutil.which("cc")}" "$@"\n')
    wrapper.chmod(0o755)
    return calls


async def test_acc_shim_33_dtr_and_rts_calls_reach_the_port_in_the_tools_order(cli_run, fake_tab):
    """ACC-SHIM-33 the DTR, RTS and break calls of a tool started with `run` reach the port in the tool's order, and the tool reads back what it set."""
    tab, path = await attach_serial(fake_tab)

    bare = await cli_run(path, launch=("-c", MODEM_LINES))
    assert bare.status != 0 and "Inappropriate ioctl for device" in bare.err, "a pty refuses the calls"
    assert tab.got("serial-signals") == []

    outcome = await cli_run("run", "--device", SERIAL_NAME, "--", sys.executable, "-c", MODEM_LINES, path)

    assert (outcome.status, outcome.err) == (0, "")
    assert ast.literal_eval(outcome.out.decode()) == MODEM_LINES_ORDER
    assert lines(tab) == MODEM_LINES_ORDER
    assert [event["brk"] for event in tab.got("serial-signals") if "brk" in event] == [True, False]
    assert tab.signals[SERIAL_NAME] == {"dtr": True, "rts": False, "brk": False}


async def test_acc_shim_33_a_modem_line_call_returns_when_the_bridge_answered(cli_run, fake_tab):
    """ACC-SHIM-33 a modem line call of the tool returns only after the bridge answered, so the tool's next step follows the port's."""
    tab, path = await attach_serial(fake_tab)
    tab.answers = False  # the bridge then answers the shim after 1 s

    outcome = await cli_run("run", "--device", SERIAL_NAME, "--", sys.executable, "-c", TIMED_CALL, path)

    assert outcome.status == 0 and 0.9 < float(outcome.out) < 3
    assert lines(tab) == [(True, False)]


async def test_acc_shim_34_a_tool_that_sets_8e1_reads_it_back_and_the_port_gets_even_parity(cli_run, fake_tab):
    """ACC-SHIM-34 under the shim a tool that sets 8E1 with tcsetattr reads back 8E1 and the port is reopened with even parity; without the shim the tool does not read 8E1 back."""
    tab, path = await attach_serial(fake_tab)

    bare = await holds(tab, await cli_run.start(path, launch=("-c", SET_FRAME), stdin=PIPE))
    assert await answer(bare, "8E1") in ("refused", "8N1"), "a pty holds no parity"
    await ends(tab, bare)
    assert configured(tab) == []

    child = await holds(tab, await cli_run.start("run", "--device", SERIAL_NAME, "--",
                                                 sys.executable, "-c", SET_FRAME, path, stdin=PIPE))
    assert await answer(child, "8E1") == "8E1"
    assert tab.settings[SERIAL_NAME] == record(tab)["settings"] == settings("8E1")
    assert await answer(child, "8E1") == "8E1", "the same format a second time is accepted too"
    assert await answer(child, "7O2") == "7O2"
    assert tab.settings[SERIAL_NAME] == settings("7O2")
    assert await answer(child, "8N1") == "8N1"
    await ends(tab, child)
    assert configured(tab) == [settings("8E1"), settings("7O2"), settings("8N1")]


async def test_acc_shim_34_the_format_and_the_baud_rate_of_one_call_reach_the_port_together(cli_run, fake_tab):
    """ACC-SHIM-34 a tool that sets its baud rate and 8E1 in one tcsetattr call has the port reopened at that rate with even parity."""
    tab, path = await attach_serial(fake_tab)

    child = await holds(tab, await cli_run.start("run", "--device", SERIAL_NAME, "--",
                                                 sys.executable, "-c", SET_FRAME, path, "57600",
                                                 stdin=PIPE))
    assert await answer(child, "8E1") == "8E1"

    assert tab.settings[SERIAL_NAME] == settings("8E1", 57600)
    assert all(each["baudRate"] == 57600 for each in configured(tab)), "never 8E1 at the baud rate it left"
    await ends(tab, child)


async def test_acc_shim_33_and_34_pyserial_under_the_shim(cli_run, fake_tab):
    """ACC-SHIM-33 ACC-SHIM-34 with pyserial as the tool its even parity and its DTR and RTS states reach the port in order; without the shim it fails or the port gets no parity."""
    tab, path = await attach_serial(fake_tab)

    bare = await cli_run.start(path, launch=("-c", PYSERIAL), stdin=PIPE)
    try:
        assert await answer(bare) in ("", "done"), "it stops with an error, or runs on without parity"
    finally:
        bare.stdin.close()
    await bare.wait()
    await tab.until(lambda: record(tab)["holder"] is None)
    assert all(each["parity"] == "none" for each in configured(tab)) and lines(tab) == []

    child = await cli_run.start("run", "--device", SERIAL_NAME, "--",
                                sys.executable, "-c", PYSERIAL, path, stdin=PIPE)

    assert await answer(child) == "done"
    assert lines(tab) == PYSERIAL_ORDER
    await tab.until(lambda: tab.settings[SERIAL_NAME] == settings("8E1"))
    order = [event["settings"]["parity"] if event["type"] == "serial-configure" else "signals"
             for event in tab.events if event["type"] in ("serial-configure", "serial-signals")]
    assert order.index("even") < order.index("signals"), "the port has the tool's parity before its first DTR and RTS state"
    await ends(tab, child)


async def test_acc_shim_34_the_format_of_a_tool_that_closed_without_a_write_ends_with_that_tool(cli_run, fake_tab):
    """ACC-SHIM-34 a tool under the shim that opens the device, sets 8E1 and closes it without a write has the port reopened with even parity each time, and the next tool gets the port's format (DEF-SHIM-3)."""
    tab, path = await attach_serial(fake_tab)

    child = await cli_run.start("run", "--device", SERIAL_NAME, "--",
                                sys.executable, "-c", OPEN_SET_CLOSE, path, stdin=PIPE)
    for _ in range(5):
        assert await answer(child, "open") == "closed"
        await tab.until(lambda: tab.settings[SERIAL_NAME] == settings("8N1"))
    child.stdin.close()
    assert await asyncio.wait_for(child.wait(), 20) == 0

    bare = await holds(tab, await cli_run.start(path, launch=("-c", SET_FRAME), stdin=PIPE))
    assert tab.settings[SERIAL_NAME] == record(tab)["settings"] == settings("8N1")
    assert configured(tab).count(settings("8E1")) == 5
    await ends(tab, bare)


async def test_acc_shim_38_descriptors_that_are_no_bridge_device_behave_as_without_the_shim(
        cli_run, fake_tab, tmp_path):
    """ACC-SHIM-38 under the shim the terminal calls on a plain pty and on a file give what they give without it."""
    _, path = await attach_serial(fake_tab)
    plain = tmp_path / "plain"
    plain.write_bytes(b"")

    bare = await cli_run(plain, path, launch=("-c", OTHER_DESCRIPTORS))
    shimmed = await cli_run("run", "--device", SERIAL_NAME, "--", sys.executable, "-c",
                            OTHER_DESCRIPTORS, plain, path)

    assert (bare.status, bare.err, shimmed.status, shimmed.err) == (0, "", 0, "")
    others, bridge = bare.out.decode().splitlines()
    others_shimmed, bridge_shimmed = shimmed.out.decode().splitlines()
    assert others_shimmed == others
    (own_pty, file) = ast.literal_eval(others)
    assert isinstance(own_pty[0], list), "the tool's own pty answered tcgetattr"
    assert file[0] == ("refused", errno.ENOTTY)
    # The shim was loaded and at work in the same run: only then the bridge device answers.
    assert ast.literal_eval(bridge) == ("refused", errno.ENOTTY)
    assert ast.literal_eval(bridge_shimmed) == bytes(4)


def test_acc_shim_36_the_shim_is_built_on_first_use_and_reused(tmp_path, monkeypatch):
    """ACC-SHIM-36 the first call compiles the shipped C source into the cache; later calls return that file without the compiler."""
    calls = counting_compiler(tmp_path / "bin")
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert shim_build.SOURCE == REPOSITORY / "jupyterlab_device_bridge_extension" / "shim" / "devshim.c"

    first = shim_build.build()
    second = shim_build.build()

    cache = tmp_path / "home" / ".cache" / "jupyterlab-device-bridge"
    assert first == second and first.parent == cache
    assert calls.read_text() == "call\n", "one compiler call for two builds"
    assert os.listdir(cache) == [first.name], "no unfinished file stays beside the library"
    assert first.read_bytes().startswith(b"\x7fELF")


def test_acc_shim_36_another_source_builds_another_library(tmp_path, monkeypatch):
    """ACC-SHIM-36 the file name carries a hash of the source, so a changed source is built again beside the old library."""
    calls = counting_compiler(tmp_path / "bin")
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    first = shim_build.build()
    changed = tmp_path / "devshim.c"
    changed.write_bytes(shim_build.SOURCE.read_bytes() + b"/* a later version */\n")
    monkeypatch.setattr(shim_build, "SOURCE", changed)

    second = shim_build.build()

    assert second != first and second.parent == first.parent
    assert first.exists() and second.exists()
    assert calls.read_text() == "call\ncall\n"


def test_acc_shim_37_without_a_compiler_the_build_names_the_settings(tmp_path, monkeypatch):
    """ACC-SHIM-37 with no C compiler on PATH the build raises an error that says the settings need no shim."""
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))

    with pytest.raises(shim_build.ShimBuildError) as refused:
        shim_build.build()

    assert "no C compiler (cc or gcc) is installed" in str(refused.value)
    assert "the settings need no shim" in str(refused.value)
    assert not (tmp_path / "home").exists()


def test_acc_shim_37_a_compiler_that_fails_names_the_settings(tmp_path, monkeypatch):
    """ACC-SHIM-37 when the compiler fails the build raises its message and says the settings need no shim; no library is left."""
    (tmp_path / "cc").write_text("#!/bin/sh\necho 'fatal error: no headers' >&2\nexit 1\n")
    (tmp_path / "cc").chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))

    with pytest.raises(shim_build.ShimBuildError) as refused:
        shim_build.build()

    assert "fatal error: no headers" in str(refused.value) and "the settings need no shim" in str(refused.value)
    assert os.listdir(tmp_path / "home" / ".cache" / "jupyterlab-device-bridge") == []
