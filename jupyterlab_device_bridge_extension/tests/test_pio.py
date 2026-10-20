"""Tests of PlatformIO on the virtual serial device.

The upload test uses a stand-in for pio that starts a child process, as pio starts avrdude
or esptool. The monitor test runs the real `pio device monitor` where one is installed, and
is skipped where none is.
"""

import asyncio
import os
import pty
import shutil
import sys

import pytest

from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_NAME

from .test_cli import cli_run, lab  # noqa: F401 - fixtures
from .test_client import attach_serial
from .test_manager import record

# The pio of the firmware environment for AVR boards (firmware-avr.py of the copier embedded project template).
FIRMWARE_AVR = os.path.expanduser("~/.cache/conda/envs/firmware-avr")
PIO = shutil.which("pio") or next(
    (path for path in [os.path.join(FIRMWARE_AVR, "bin", "pio")] if os.access(path, os.X_OK)), None)

# Sets DTR, then RTS, on the device that argv[1] names, as an upload program does to reset a board.
SETS_DTR_THEN_RTS = """
import fcntl, os, struct, sys, termios
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
for line in (termios.TIOCM_DTR, termios.TIOCM_RTS):
    fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("i", line))
"""
# A stand-in for pio: `pio run -t upload --upload-port <path>` starts a child process that
# sets the lines on that path, and exits with the status of that child.
FAKE_PIO = f"""#!{sys.executable}
import subprocess, sys
port = sys.argv[sys.argv.index("--upload-port") + 1]
sys.exit(subprocess.run([sys.executable, "-c", {SETS_DTR_THEN_RTS!r}, port]).returncode)
"""


def modem_lines(tab):
    """`(dtr, rts)` of every `serial-signals` with the two modem lines that a tab got, in order."""
    return [(event["dtr"], event["rts"]) for event in tab.got("serial-signals") if "dtr" in event]


async def test_acc_shim_183_the_dtr_and_rts_calls_of_a_program_that_pio_starts_reach_the_port(
        cli_run, fake_tab, tmp_path):
    """ACC-SHIM-183 under `run --device <name> -- pio run -t upload --upload-port <path>` the DTR and then the RTS call of the child process that pio starts reach the port in that order; without `run` the pty refuses them and the port gets nothing."""
    tab, path = await attach_serial(fake_tab)
    pio = tmp_path / "pio"
    pio.write_text(FAKE_PIO)
    pio.chmod(0o755)
    upload = (str(pio), "run", "-t", "upload", "--upload-port", path)

    bare = await cli_run(*upload[1:], launch=(str(pio),))
    assert bare.status != 0 and "Inappropriate ioctl for device" in bare.err, "a pty refuses the calls"
    assert tab.got("serial-signals") == []

    outcome = await cli_run("run", "--device", SERIAL_NAME, "--", *upload)

    assert (outcome.status, outcome.err) == (0, "")
    await tab.until(lambda: len(modem_lines(tab)) == 2)
    assert modem_lines(tab) == [(True, False), (True, True)]


@pytest.mark.skipif(PIO is None, reason="no pio is installed: neither on PATH nor in the conda environment "
                                        "firmware-avr (~/.cache/conda/envs/firmware-avr/bin/pio)")
async def test_acc_term_185_pio_device_monitor_shows_the_port_output_and_sends_typed_bytes(fake_tab, tmp_path):
    """ACC-TERM-185 the real `pio device monitor --port <path> --baud <rate>` on the virtual device shows what the port sends and sends what is typed, as any serial tool on the path; Ctrl+C ends it and the device has no holder after."""
    tab, path = await attach_serial(fake_tab)
    tab.echo = False
    # pio runs on the Python of its own environment, which the Python variables of this test run do not fit.
    environment = {name: value for name, value in os.environ.items() if not name.startswith("PYTHON")}
    core = os.path.join(os.path.dirname(os.path.dirname(PIO)), "platformio")
    if os.path.isdir(core):  # the core directory that the conda environment of this pio sets
        environment["PLATFORMIO_CORE_DIR"] = core
    keyboard, terminal = pty.openpty()
    os.set_blocking(keyboard, False)
    child = await asyncio.create_subprocess_exec(
        PIO, "device", "monitor", "--port", path, "--baud", "115200",
        stdin=terminal, stdout=terminal, stderr=terminal, env=environment, cwd=tmp_path)
    os.close(terminal)
    screen = b""

    def shows(text):
        nonlocal screen
        try:
            screen += os.read(keyboard, 65536)
        except (BlockingIOError, OSError):
            pass
        return text in screen

    try:
        await tab.until(lambda: record(tab)["holder"], timeout=60)
        await tab.until(lambda: shows(b"--- Terminal on "), timeout=30)
        await tab.port_sends(SERIAL_NAME, b"hello from the board\r\n")
        await tab.until(lambda: shows(b"hello from the board"), timeout=10)
        os.write(keyboard, b"abc")
        await tab.until(lambda: tab.written(SERIAL_NAME) == b"abc", timeout=10)
        os.write(keyboard, b"\x03")
        await asyncio.wait_for(child.wait(), 20)
        await tab.until(lambda: record(tab)["holder"] is None)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
        os.close(keyboard)
