#!/usr/bin/env python3
"""jupyterlab-device - reach a serial port or a USB device of the browser's computer.

The device is plugged into the computer where the JupyterLab tab runs. The tab holds
it through Web Serial or WebUSB after the user granted it in Chrome's dialog, and the
Jupyter server passes it to programs in this container:

- a serial port becomes a virtual serial device: a path that a serial tool opens
  as it opens any serial port. `jupyterlab-device list` prints the path
- a USB device is reached with `jupyterlab-device usb`, with the Python module
  jupyterlab_device_bridge_extension.client, or with its pyusb backend

    jupyterlab-device list
    jupyterlab-device profile tty-2341-0043 arduino-upload
    jupyterlab-device monitor read tty-2341-0043 --lines 20

Run it in a terminal of the lab and keep the lab tab open: the tab moves every byte.
A device exists here only after the user attached it in the Devices panel of the lab
(if no sidebar has the panel: menu View, item Show Devices Panel).
"""

import argparse
import codecs
import contextlib
import json
import os
import shutil
import sys
import time

from . import shim_build
from .client import DeviceBridgeClient, DeviceBridgeError
from .profiles import ACTIONS

PROG = "jupyterlab-device"
# Longest single wait the CLI asks of the server while it follows or polls.
POLL_S = 5.0
FOLLOW_S = 10.0
# The server drops a device request nobody answered after this long (docs/design.md).
REQUEST_S = 300.0
# How long `run` and `shell` wait for each answer that their tool does not need: the server
# lists the process as a run, and it gives the devices for the banner of `shell` (docs/design.md).
RUN_REGISTER_S = 2.0
# The known upload tools. For each: its command line of the README section Working with an AI
# agent, with <path> in place of the path of the device, and whether that line needs the shim.
UPLOAD_TOOLS = (
    ("avrdude", "avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i", False),
    ("stm32flash", "stm32flash -b 115200 -w firmware.bin -v -g 0x0 <path>", True),
    ("esptool", "esptool --port <path> write-flash 0x0 firmware.bin", True),
)
_TOOL_NAMES = [name for name, _, _ in UPLOAD_TOOLS]
# The bits of the square wave at the top of the banner: the letters J and L as two serial
# frames (start bit, 8 data bits with the lowest first, stop bit) between idle bits.
_BANNER_BITS = "11" + "0010100101" + "0001100101" + "11111"


def _wave(bits: str) -> str:
    """Two rows that draw the bits as a square wave, two columns for each bit."""
    top, bottom, last = "", "", bits[0]
    for bit in bits:
        high = bit == "1"
        if bit == last:
            top, bottom = top + ("\u2500" if high else " "), bottom + (" " if high else "\u2500")
        else:  # an edge takes the first column of the new bit
            top, bottom = top + ("\u250c" if high else "\u2510"), bottom + ("\u2518" if high else "\u2514")
        top, bottom, last = top + ("\u2500" if high else " "), bottom + (" " if high else "\u2500"), bit
    return f"{top.rstrip()}\n{bottom.rstrip()}"


# The fixed lines of the banner of a device shell, above and under its lines of the tools and of
# the devices. This file holds ASCII only, so the characters of the wave, of the rule (U+2500)
# and the diamond (U+25C6) are written as escapes.
BANNER_TOP = (
    _wave(_BANNER_BITS),
    f"\u25c6 {PROG}" + " " * 23 + "device shell",
    "",
)
BANNER_BOTTOM = (
    "",
    f"{PROG} list      all devices",
    f"{PROG} --help    example commands",
    "\u2500" * 54,
)


def _tools_on_path() -> list[tuple[str, str, bool]]:
    """The known upload tools that PATH holds at this moment, in the order of `UPLOAD_TOOLS`."""
    return [tool for tool in UPLOAD_TOOLS if shutil.which(tool[0])]


def _tool_lines() -> list[str]:
    """The lines of the banner about the upload tools: the ones on PATH, or that one must be installed."""
    found = [name for name, _, _ in _tools_on_path()]
    if found:
        return [f"For {', '.join(found)}."]
    return [f"No {', '.join(_TOOL_NAMES[:-1])} or {_TOOL_NAMES[-1]} on PATH.",
            "Install one to make use of the device shell."]


def _device_lines(table: dict) -> list[str]:
    """The device lines of the banner for the device table of the server.

    One numbered line for each device that is attached and has no error, the serial devices
    first: the path of a serial device, the name of a USB device. One line that says so when
    no device is such a device.
    """
    usable = [f"{record[field]} ({kind})"
              for group, field, kind in (("serial", "path", "COM"), ("usb", "name", "USB"))
              for record in table[group] if record["state"] == "attached" and not record["error"]]
    return [f"({number}) {line}" for number, line in enumerate(usable, 1)] or ["No device is attached."]


def _banner(device_lines: list[str]) -> str:
    """What `shell` prints on a terminal before it becomes the shell.

    The banner in pale cyan, then the colour reset and an empty line.
    """
    lines = "\n".join([*BANNER_TOP, *_tool_lines(), *device_lines, *BANNER_BOTTOM])
    return f"\x1b[38;2;159;224;238m{lines}\x1b[0m\n\n"


def _upload_examples() -> str:
    """The end of the top-level help: one example for each known upload tool on PATH now.

    A line of a tool that needs the shim starts with `run --`, except inside a device shell,
    where every tool has the shim already.
    """
    prefix = "" if "JUPYTERLAB_DEVICE_SHIM_DIR" in os.environ else f"{PROG} run -- "
    lines = [f"  {prefix if shim else ''}{line}" for _, line, shim in _tools_on_path()]
    if not lines:
        return f"No upload tool is on PATH. Known tools: {', '.join(_TOOL_NAMES)}."
    return "\n".join([
        "examples for the upload tools on PATH; <path> is the path of the serial device,",
        f"which `{PROG} list` prints:",
        *lines])


USB_READ_LENGTH = 64

HINTS = {
    None: "start JupyterLab, or run this command in a terminal of the lab",
    401: "the token was refused; run this command in a terminal of the lab",
    403: "the token was refused; run this command in a terminal of the lab",
    409: "open the lab in Chrome or Edge and attach the device in the Devices panel "
         "(if no sidebar has the panel: menu View, item Show Devices Panel)",
    504: "the lab tab did not answer, or the device sent no data in that time: check that the lab "
         "tab is open, then run the command again or give a USB read a longer --timeout",
}


class UsageError(Exception):
    """Arguments that argparse accepts and the command cannot carry out."""


def _say(message: str) -> None:
    """One line on stderr; stdout carries results only."""
    print(f"{PROG}: {message}", file=sys.stderr, flush=True)


def _explain(error: DeviceBridgeError) -> str:
    """The error with the next step for the caller, where the message does not hold it already."""
    if error.code in ("unknown-device", "invalid-name"):
        hint = f"run `{PROG} list` for the names of the attached devices"
    elif error.status == 404 and not error.code:
        hint = "that server has no device bridge; check `jupyter server extension list`"
    else:
        hint = HINTS.get(error.status)
    return f"{error} - {hint}" if hint else str(error)


def _print_json(document: object) -> int:
    print(json.dumps(document, indent=2))
    return 0


def _number(text: str) -> int:
    """An integer argument: decimal, or hexadecimal with the prefix 0x."""
    return int(text, 0)


def _line_count(text: str) -> int:
    """A number of lines: 0 or more."""
    count = int(text)
    if count < 0:
        raise ValueError(text)
    return count


def _usb_id(text: str) -> int:
    """A USB vendor or product id: 4 hexadecimal digits, with or without 0x."""
    return int(text, 16)


def _settings_text(settings: dict) -> str:
    """Serial settings in the usual short form, for example `115200 8N1`."""
    return (f"{settings['baudRate']} {settings['dataBits']}"
            f"{settings['parity'][0].upper()}{settings['stopBits']}")


def _yes_no(present: bool) -> str:
    return "yes" if present else "no"


def _usb_line(record: dict) -> str:
    return (f"usb     {record['name']}  {record['state']}  "
            f"{record['vendorId']:04x}:{record['productId']:04x}  "
            f"{'open' if record['opened'] else 'closed'}  {record['productName'] or '-'}")


def cmd_list(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    devices = bridge.devices()
    if args.json:
        return _print_json(devices)
    for record in devices["serial"]:
        holder = record["holder"]
        held = f"held by {holder['name']} (pid {holder['pid']})" if holder else "free"
        error = f"  error: {record['error']}" if record["error"] else ""
        # An action that is not the profile's: a default of the lab's settings, or `--on-open`.
        on_open = record["overrides"].get("onOpen")
        action = f"  on open {on_open}" if on_open else ""
        print(f"serial  {record['name']}  {record['state']}  {record['path']}  "
              f"{_settings_text(record['settings'])}  profile {record['profile']}{action}  "
              f"{held}{error}")
    for record in devices["usb"]:
        print(_usb_line(record))
    if not devices["serial"] and not devices["usb"]:
        _say("no device is attached - open the Devices panel of the lab (if no sidebar has the "
             "panel: menu View, item Show Devices Panel) and add a serial port or a USB device")
    return 0


def cmd_status(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    status = {"server": bridge.base_url, **bridge.status()}
    if args.json:
        return _print_json(status)
    print(f"server: {status['server']} (device bridge {status['version']})")
    print(f"device directory: {status['deviceDir']}")
    print(f"shim directory: {status['shimDir']}")
    print(f"devices: {status['counts']['serial']} serial, {status['counts']['usb']} usb")
    print(f"pending requests: {status['counts']['requests']}")
    for tab in status["tabs"]:
        trip = "not measured" if tab["roundTrip"] is None else f"{tab['roundTrip']:g} ms"
        print(f"tab {tab['tabId']}: Web Serial {_yes_no(tab['serial'])}, "
              f"WebUSB {_yes_no(tab['usb'])}, round trip {trip}")
    if not status["tabs"]:
        _say("no lab tab is connected - open the lab in Chrome or Edge, over HTTPS or localhost")
    return 0


def cmd_profiles(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    profiles = bridge.profiles()
    if args.json:
        return _print_json(profiles)
    for profile in profiles:
        print(f"{profile['id']:<18}{_settings_text(profile):<12}"
              f"on open: {profile['onOpen']:<16}{profile['label']}")
    return 0


def cmd_profile(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    port = bridge.serial(args.device)
    flags = {"profile": args.id, "baudRate": args.baud, "dataBits": args.data_bits,
             "parity": args.parity, "stopBits": args.stop_bits, "onOpen": args.on_open}
    change = {field: value for field, value in flags.items() if value is not None}
    record = port.set_profile(**change) if change else port.record()
    overrides = ", ".join(f"{field}={value}" for field, value in record["overrides"].items())
    on_open = record["overrides"].get("onOpen") or next(
        profile["onOpen"] for profile in bridge.profiles() if profile["id"] == record["profile"])
    print(f"{record['name']}: profile {record['profile']}, overrides {overrides or 'none'}, "
          f"settings {_settings_text(record['settings'])}, on open {on_open}")
    return 0


def cmd_monitor_read(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    port = bridge.serial(args.device)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def emit(data: bytes) -> None:
        if args.raw:
            sys.stdout.buffer.write(data)
        else:
            sys.stdout.write(decoder.decode(data))
        sys.stdout.flush()

    chunk = port.monitor()
    data = chunk["data"]
    if args.lines is not None:
        data = b"".join(data.splitlines(keepends=True)[-args.lines:]) if args.lines else b""
    emit(data)
    if not args.follow:
        return 0

    deadline = time.monotonic() + args.timeout
    while (remaining := deadline - time.monotonic()) > 0:
        chunk = port.monitor(since=chunk["next"], wait=min(remaining, POLL_S))
        if chunk["dropped"]:
            _say("the monitor buffer overran: some output is missing here")
        emit(chunk["data"])
    return 0


def cmd_monitor_write(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    data = sys.stdin.buffer.read() if args.text is None else args.text.encode()
    if args.hex:
        try:
            data = bytes.fromhex(data.decode("ascii"))
        except ValueError:
            raise UsageError("with --hex the text is hexadecimal digits, for example `7f 00 a5`") from None
    if args.newline:
        data += b"\n"
    bridge.serial(args.device).write(data)
    return 0


def cmd_terminal(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    record = bridge.serial(args.device).record()
    holder = record["holder"]
    if holder:
        _say(f"{args.device} is held by {holder['name']} (pid {holder['pid']}) - "
             "wait until that program ends or stop it, then run this command again")
        return 1
    baud = args.baud or record["settings"]["baudRate"]
    _say("starting miniterm - Ctrl+] quits, Ctrl+T opens its menu (Ctrl+T then Ctrl+H lists the keys)")
    # The terminal is pyserial's miniterm and nothing of this extension: the process
    # becomes miniterm, which opens the path as any serial tool does.
    command = [sys.executable, "-m", "serial.tools.miniterm", record["path"], str(baud)]
    os.execv(command[0], command)


def cmd_signals(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    if args.dtr is None and args.rts is None:
        raise UsageError("name a line to set: --dtr 0|1, --rts 0|1, or both")
    bridge.serial(args.device).signals(
        dtr=None if args.dtr is None else bool(args.dtr),
        rts=None if args.rts is None else bool(args.rts),
    )
    return 0


def cmd_action(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    bridge.serial(args.device).action(args.action)
    return 0


def _start_with_shim(bridge: DeviceBridgeClient, command: list[str] | None,
                     device: str | None = None) -> int:
    """What `run` and `shell` do: build the shim, register the run, and become the tool.

    Args:
        command: The words of the tool. None stands for a device shell: the shell command
            of the lab's terminals, which the server reports.
        device: The `--device` of `run`: the tool is not started unless it is attached.
    """
    try:
        shim = shim_build.build()
    except shim_build.ShimBuildError as error:
        _say(str(error))
        return 1
    if device and bridge.serial(device).record()["state"] != "attached":
        raise DeviceBridgeError(409, f"{device} is detached: no lab tab holds it", code="detached")
    status = bridge.status()
    environment = dict(os.environ)
    preloaded = environment.get("LD_PRELOAD")
    environment["LD_PRELOAD"] = f"{shim}:{preloaded}" if preloaded else str(shim)
    environment["JUPYTERLAB_DEVICE_SHIM_DIR"] = status["shimDir"]
    device_shell = command is None
    if device_shell:
        # The variable SHELL is not read: a lab can start its terminals without it.
        command = status.get("shell")
        if not command:
            _say(f"the server (device bridge {status['version']}) does not report the shell command of "
                 "its terminals - restart JupyterLab, so that the server runs the version of this command")
            return 1
    # The server lists this process as a run, so the lab can show it and stop it. The
    # tool starts whatever becomes of that call, and nothing is printed about it. A device
    # shell is listed under its own name: the shell command of a lab can be a start script.
    run = {"pid": os.getpid(), "command": [PROG, "shell"] if device_shell else command}
    if device:
        run["device"] = device
    with contextlib.suppress(Exception):
        bridge.call("POST", "runs", run, timeout=RUN_REGISTER_S)
    if device_shell and sys.stdout.isatty():
        # The devices are read for the banner alone. Without them it has no device line.
        device_lines = []
        with contextlib.suppress(Exception):
            device_lines = _device_lines(bridge.call("GET", "devices", timeout=RUN_REGISTER_S))
        # As UTF-8 bytes: a text write fails where the locale has no such characters. Flushed,
        # because the shell replaces this process and what it has not written yet.
        sys.stdout.buffer.write(_banner(device_lines).encode())
        sys.stdout.flush()
    try:
        os.execvpe(command[0], command, environment)
    except (OSError, ValueError) as error:  # ValueError: the first word of the tool is empty
        reason = error.strerror if isinstance(error, OSError) else error
        hint = "check the name of the tool and its PATH"
        if device_shell:
            hint = ("it is the shell command of the lab's terminals, "
                    f"which `{PROG} status --json` shows as shell")
        _say(f"cannot start {command[0]}: {reason} - {hint}")
    return 127


def cmd_run(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    if not args.command:
        raise UsageError(f"name the tool after `--`, for example `{PROG} run -- avrdude -c arduino ...`")
    return _start_with_shim(bridge, args.command, args.device)


def cmd_shell(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    return _start_with_shim(bridge, None)


def cmd_request(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    request = bridge.request_device(args.kind, args.reason, args.vid, args.pid)
    _say("waiting for the user to press Grant in the lab")
    deadline = time.monotonic() + args.timeout
    while request["state"] == "pending" and (remaining := deadline - time.monotonic()) > 0:
        request = bridge.request_state(request["id"], wait=min(remaining, POLL_S))
    if request["state"] == "granted":
        print(request["name"])
        return 0
    if request["state"] == "denied":
        error = request.get("error") or {}
        reason = ": ".join(filter(None, (error.get("name"), error.get("message"))))
        _say(f"the request was denied: {reason or 'the lab gave no reason'}")
        return 1
    _say(f"nobody answered the request within {args.timeout:g} s - ask the user to open the "
         "Devices panel of the lab (if no sidebar has the panel: menu View, item Show Devices "
         "Panel) and press Grant, then run this command again")
    return 2


def cmd_usb_list(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    for record in bridge.devices()["usb"]:
        print(_usb_line(record))
    return 0


def cmd_usb_describe(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    return _print_json(bridge.usb(args.device).describe())


def cmd_usb_operation(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    """One operation without a result: the method and its arguments come from the parser."""
    getattr(bridge.usb(args.device), args.method)(*(getattr(args, name) for name in args.fields))
    return 0


def cmd_usb_clear_halt(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    bridge.usb(args.device).clear_halt("in" if args.endpoint & 0x80 else "out", args.endpoint & 0x7F)
    return 0


def _print_transfer(result: bytes | int) -> int:
    """Bytes the device sent as hex; for a transfer out the number of bytes written."""
    print(result.hex() if isinstance(result, bytes) else result)
    return 0


def _payload(args: argparse.Namespace) -> bytes:
    try:
        return bytes.fromhex(args.data)
    except ValueError:
        raise UsageError("--data is hexadecimal digits, for example `--data 0102ff`") from None


def cmd_usb_control(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    reads = args.request_type & 0x80
    return _print_transfer(bridge.usb(args.device).control(
        args.request_type, args.request, args.value, args.index,
        args.length if reads else _payload(args), args.timeout,
    ))


def cmd_usb_transfer(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    device = bridge.usb(args.device)
    number = args.endpoint & 0x7F
    if args.endpoint & 0x80:
        return _print_transfer(device.transfer_in(number, args.length, args.timeout))
    return _print_transfer(device.transfer_out(number, _payload(args), args.timeout))


def _sub(sub: argparse._SubParsersAction, name: str, help_: str, description: str,
         examples: str) -> argparse.ArgumentParser:
    """Add a subcommand with prose under its usage line and examples under its options."""
    return sub.add_parser(
        name, help=help_, description=description.strip("\n"),
        epilog="examples:\n" + examples.strip("\n"),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )


def _add_serial_commands(sub: argparse._SubParsersAction) -> None:
    p = _sub(sub, "profile", "show or set the profile of a serial port", """
A profile is the serial settings the browser opens the port with (baud rate, data
bits, parity, stop bits) and the action it runs when a tool opens the virtual device.
Without an id and without a flag the command prints the device's profile. With an
id it sets that built-in profile and removes the fields overridden before; a flag
overrides one field of the profile. The change applies at once and stays until it
is changed again. Prints one line: the profile id, the overridden fields, the
settings now in use and the action on open.

While a tool holds the device the baud rate is the one the tool sets. A pty cannot
carry parity, data bits or stop bits, so those come from the profile (or from the
tool itself when it runs under `jupyterlab-device run`).
""", """
  jupyterlab-device profile tty-2341-0043
  jupyterlab-device profile tty-2341-0043 arduino-upload
  jupyterlab-device profile tty-0483-5740 stm32-bootloader --baud 57600
  jupyterlab-device profile tty-10c4-ea60 --on-open none
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("id", nargs="?", help="id of a built-in profile, as `profiles` prints it")
    p.add_argument("--baud", type=int, metavar="N", help="baud rate while no tool holds the device")
    p.add_argument("--data-bits", type=int, choices=(7, 8), help="data bits")
    p.add_argument("--parity", choices=("none", "even", "odd"), help="parity")
    p.add_argument("--stop-bits", type=int, choices=(1, 2), help="stop bits")
    p.add_argument("--on-open", choices=ACTIONS,
                   help="action the browser runs on the port when a tool opens the device")
    p.set_defaults(func=cmd_profile)

    monitor = _sub(sub, "monitor", "read what a serial port sent, or send bytes to it", """
The server keeps the most recent bytes every serial port sent (262144 by default),
also while no program reads the device. `monitor read` prints them, so a call made
after the board printed still shows the output. `monitor write` sends bytes.
Neither one opens the virtual device, so both work while a tool holds it.
""", """
  jupyterlab-device monitor read tty-2341-0043 --lines 20
  jupyterlab-device monitor write tty-2341-0043 "status" --newline
""").add_subparsers(dest="monitor_command", required=True, metavar="COMMAND")

    p = _sub(monitor, "read", "print the buffered output of a serial port", """
Prints the bytes the port sent that the server still keeps, oldest first, as UTF-8
text; a byte that is not UTF-8 prints as the replacement character. With --follow
the command then prints new bytes as they arrive and exits 0 when --timeout ends:
it runs for that whole time, so choose the time that the board needs.
""", """
  jupyterlab-device monitor read tty-2341-0043
  jupyterlab-device monitor read tty-2341-0043 --lines 20
  jupyterlab-device monitor read tty-2341-0043 --lines 0 --follow --timeout 15
  jupyterlab-device monitor read tty-2341-0043 --raw > capture.bin
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--lines", type=_line_count, metavar="N",
                   help="print only the last N lines of the buffer; 0 prints none of it")
    p.add_argument("--follow", action="store_true",
                   help="after the buffer, print new output until --timeout ends")
    p.add_argument("--timeout", type=float, default=FOLLOW_S, metavar="S",
                   help=f"seconds that --follow runs (default {FOLLOW_S:g})")
    p.add_argument("--raw", action="store_true",
                   help="write the bytes unchanged, for binary output")
    p.set_defaults(func=cmd_monitor_read)

    p = _sub(monitor, "write", "send bytes to a serial port", """
Sends TEXT to the port as UTF-8, or the bytes of standard input when TEXT is
omitted. Nothing is added to the bytes unless --newline is given. Prints nothing.
Fails when the device is detached: the bytes would reach no port.
""", """
  jupyterlab-device monitor write tty-2341-0043 "led on" --newline
  jupyterlab-device monitor write tty-2341-0043 --hex "7f 00 a5"
  printf 'AT\\r\\n' | jupyterlab-device monitor write tty-10c4-ea60
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("text", nargs="?", metavar="TEXT", help="what to send; standard input when omitted")
    p.add_argument("--hex", action="store_true",
                   help="TEXT (or standard input) is hexadecimal digits; spaces are allowed")
    p.add_argument("--newline", action="store_true", help="send a line feed (0x0a) after the bytes")
    p.set_defaults(func=cmd_monitor_write)

    p = _sub(sub, "terminal", "open the serial terminal program on a serial port", """
Starts pyserial's miniterm on the device's path and becomes that program: an
interactive terminal for a person, not for a script. It needs a terminal on its
standard input and runs until Ctrl+] is pressed; Ctrl+T opens miniterm's menu. A
program without a terminal reads with `monitor read` and writes with `monitor write`.

The baud rate is the profile's unless --baud is given. The command refuses, with
exit status 1, when another program holds the device, and names that program.
miniterm opens the device as every tool does, so the action on open of the
device's profile runs first. Set the profile `monitor` to open the terminal
without an action.
""", """
  jupyterlab-device terminal tty-2341-0043
  jupyterlab-device terminal tty-2341-0043 --baud 9600
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--baud", type=int, metavar="N", help="baud rate (default: the profile's)")
    p.set_defaults(func=cmd_terminal)

    p = _sub(sub, "signals", "set the DTR and RTS lines of a serial port", """
Sets the control lines of the port in the browser, at once, and leaves them so.
1 asserts the line, 0 releases it. A line that is not named keeps its state.
Prints nothing.
""", """
  jupyterlab-device signals tty-2341-0043 --dtr 0
  jupyterlab-device signals tty-10c4-ea60 --dtr 0 --rts 1
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--dtr", type=int, choices=(0, 1), help="state of the DTR line")
    p.add_argument("--rts", type=int, choices=(0, 1), help="state of the RTS line")
    p.set_defaults(func=cmd_signals)

    p = _sub(sub, "action", "run one reset or bootloader action on a serial port", """
Runs one action on the port in the browser, now. These are the actions a profile
runs when a tool opens the device:

  pulse-dtr       DTR off, 100 ms, DTR on: the reset pulse for an Arduino Uno,
                  Nano or Mega
  pulse-rts       RTS off, 100 ms, RTS on
  esp-bootloader  the DTR and RTS sequence for entering the ESP serial bootloader
  touch-1200      opens the port at 1200 baud and closes it: the board may come
                  back as another USB device, which needs its own grant
  none            nothing

Prints nothing.
""", """
  jupyterlab-device action tty-2341-0043 pulse-dtr
  jupyterlab-device action tty-10c4-ea60 esp-bootloader
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("action", choices=ACTIONS, help="the action to run")
    p.set_defaults(func=cmd_action)


def _add_usb_commands(sub: argparse._SubParsersAction) -> None:
    usb = _sub(sub, "usb", "descriptors and raw operations of a USB device", """
Raw WebUSB operations on an attached USB device, one browser call per command.
The device stays open and its interfaces stay claimed between commands, until
`usb close` or until the lab tab closes. Numbers are decimal, or hexadecimal with
the prefix 0x. Bytes are printed and given as hexadecimal digits.

A refusal of the browser is printed with Chrome's own error name and message.
A program that speaks pyusb uses the backend in
jupyterlab_device_bridge_extension.pyusb_backend and needs none of these commands.
""", """
  jupyterlab-device usb list
  jupyterlab-device usb open usb-0483-3748
  jupyterlab-device usb control usb-0483-3748 0x80 6 0x0100 0 --length 18
""").add_subparsers(dest="usb_command", required=True, metavar="COMMAND")

    p = _sub(usb, "list", "list the USB devices", """
Prints one line per USB device: name, state (attached or detached), vendor and
product id, open or closed, product name. `list --json` has the full records.
""", """
  jupyterlab-device usb list
""")
    p.set_defaults(func=cmd_usb_list)

    p = _sub(usb, "describe", "print the descriptors of a USB device", """
Prints one JSON document: the device's configurations, interfaces, endpoints and
strings as the browser reports them. The raw descriptors are in it once the
device was opened.
""", """
  jupyterlab-device usb describe usb-0483-3748
""")
    p.add_argument("device", help="name of the USB device, as `usb list` prints it")
    p.set_defaults(func=cmd_usb_describe)

    operations = (
        ("open", "open", "open the device in the browser",
         "Opens the device. Every other operation needs an open device.", ()),
        ("close", "close", "close the device in the browser",
         "Closes the device and releases its interfaces.", ()),
        ("claim", "claim_interface", "claim an interface",
         "Claims an interface for the lab tab. A transfer on an endpoint needs its "
         "interface claimed.\nThe browser refuses an interface that a system driver holds.",
         (("interface", "interface number (bInterfaceNumber)"),)),
        ("release", "release_interface", "release a claimed interface",
         "Releases an interface that was claimed.",
         (("interface", "interface number (bInterfaceNumber)"),)),
        ("configuration", "select_configuration", "select a configuration",
         "Selects the configuration with the given value.",
         (("value", "configuration value (bConfigurationValue)"),)),
        ("alternate", "select_alternate", "select an alternate setting of an interface",
         "Selects an alternate setting of a claimed interface.",
         (("interface", "interface number (bInterfaceNumber)"),
          ("setting", "alternate setting (bAlternateSetting)"))),
        ("reset", "reset", "reset the device",
         "Resets the device. The device may leave the bus and come back.", ()),
    )
    for name, method, help_, description, parameters in operations:
        p = _sub(usb, name, help_, f"{description} Prints nothing.",
                 f"  {PROG} usb {name} usb-0483-3748" + " 0" * len(parameters))
        p.add_argument("device", help="name of the USB device, as `usb list` prints it")
        for parameter, parameter_help in parameters:
            p.add_argument(parameter, type=_number, help=parameter_help)
        p.set_defaults(func=cmd_usb_operation, method=method,
                       fields=[parameter for parameter, _ in parameters])

    p = _sub(usb, "clear-halt", "clear the halt of an endpoint", """
Clears the halt (stall) condition of an endpoint. Prints nothing.
""", """
  jupyterlab-device usb clear-halt usb-0483-3748 0x81
""")
    p.add_argument("device", help="name of the USB device, as `usb list` prints it")
    p.add_argument("endpoint", type=_number,
                   help="endpoint address (bEndpointAddress); bit 7 set means IN, as in 0x81")
    p.set_defaults(func=cmd_usb_clear_halt)

    p = _sub(usb, "control", "run one control transfer", """
Runs one control transfer on endpoint 0 with the four setup fields of USB. Bit 7 of
REQUEST_TYPE gives the direction, as in libusb: set (0x80, 0xc0, ...) reads --length
bytes and prints them as hexadecimal digits; clear (0x00, 0x40, ...) sends the --data
bytes and prints how many were written. A stall is an error with the name `stall`.
""", """
  jupyterlab-device usb control usb-0483-3748 0x80 6 0x0100 0 --length 18
  jupyterlab-device usb control usb-16c0-05dc 0x40 1 0 0 --data 01ff
""")
    p.add_argument("device", help="name of the USB device, as `usb list` prints it")
    p.add_argument("request_type", type=_number, metavar="REQUEST_TYPE", help="bmRequestType")
    p.add_argument("request", type=_number, metavar="REQUEST", help="bRequest")
    p.add_argument("value", type=_number, metavar="VALUE", help="wValue")
    p.add_argument("index", type=_number, metavar="INDEX", help="wIndex")
    _add_transfer_options(p)
    p.set_defaults(func=cmd_usb_control)

    p = _sub(usb, "transfer", "run one bulk or interrupt transfer", """
Runs one transfer on a bulk or interrupt endpoint of a claimed interface. Bit 7 of
ENDPOINT gives the direction: an IN endpoint (0x81) reads at most --length bytes and
prints them as hexadecimal digits; an OUT endpoint (0x01) sends the --data bytes and
prints how many were written. A read that gets no bytes within --timeout fails with
exit status 1; the bytes that arrive later are returned by the next read.
""", """
  jupyterlab-device usb transfer usb-0483-3748 0x01 --data f10100
  jupyterlab-device usb transfer usb-0483-3748 0x81 --length 64 --timeout 1000
""")
    p.add_argument("device", help="name of the USB device, as `usb list` prints it")
    p.add_argument("endpoint", type=_number, metavar="ENDPOINT",
                   help="endpoint address (bEndpointAddress), for example 0x81 or 0x01")
    _add_transfer_options(p)
    p.set_defaults(func=cmd_usb_transfer)


def _add_transfer_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--length", type=_number, default=USB_READ_LENGTH, metavar="N",
                        help=f"most bytes to read in an IN transfer (default {USB_READ_LENGTH})")
    parser.add_argument("--data", default="", metavar="HEX",
                        help="bytes to send in an OUT transfer, as hexadecimal digits (default: none)")
    parser.add_argument("--timeout", type=int, metavar="MS",
                        help="milliseconds to wait for the device (default: 5000)")


def build_parser() -> argparse.ArgumentParser:
    """The parser of the whole CLI; `--help` of every level is written for an agent."""
    parser = argparse.ArgumentParser(
        prog=PROG, description=__doc__,
        epilog=f"""
Every command has its own --help with examples: `{PROG} monitor read --help`.

exit status:
  0  done
  1  not done; one line on stderr names the reason and the next step
  2  wrong arguments; for `request`: nobody answered in time
  130  stopped with Ctrl+C
  `run` exits with the status of the tool it started, and with 127 when the tool
  cannot be started; `shell` does the same with the shell; `terminal` exits with
  the status of the terminal program

Results go to stdout and messages to stderr.

The server is the first one that `jupyter server list` reports, reached on 127.0.0.1
without a proxy.

environment:
  JUPYTERHUB_API_TOKEN, JPY_API_TOKEN  the token; under JupyterHub it outranks the server's own
  JUPYTER_TOKEN                        the token when `jupyter server list` reports no server
  JUPYTER_PORT, JUPYTERHUB_SERVICE_PREFIX
                                       where the server answers when the list reports none

{_upload_examples()}
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    p = _sub(sub, "list", "list the devices with path, state, holder and settings", """
Prints one line per device.

A serial line: `serial`, name, state, path, settings, profile, holder. The path is
what a serial tool opens. State `attached` means a lab tab holds the port; on a
`detached` device the path still opens but no byte reaches the board. After the
profile the line has `on open <action>` when the port has an action on open of
its own, which runs in place of the profile's: the user can set one as a default
in the settings of the lab, and `profile --on-open` sets one. The holder is
the program that has the path open now, or `free`. The line ends with
`error: <reason>` for a port that failed in the browser, for example one the
browser could not open, or with `error: removed` for an unplugged port. The
browser does not open a port with `error: <reason>` again by itself: tell the
user the reason and, when the cause is gone, set the profile of the board again
with `jupyterlab-device profile <device> <id>`. A profile change asks the
browser to open the port again. Then run `list` again, and upload only when the
line has no `error:`.

A USB line: `usb`, name, state, vendor:product id, open or closed, product name.

With no device the command prints nothing on stdout and exits 0.
""", """
  jupyterlab-device list
  jupyterlab-device list --json
""")
    p.add_argument("--json", action="store_true",
                   help="print the device table as one JSON document: {serial: [...], usb: [...]}")
    p.set_defaults(func=cmd_list)

    p = _sub(sub, "status", "show the server, its lab tabs and the browser interfaces", """
Prints the server this command found and what its bridge reports: the version, the
device directory, the shim directory, the number of devices and of pending device
requests, and each connected lab tab with the interfaces its browser has (Web Serial,
WebUSB) and the round trip between server and browser. No connected tab means no
device can be attached: open the lab in Chrome or Edge, over HTTPS or localhost.
""", """
  jupyterlab-device status
  jupyterlab-device status --json
""")
    p.add_argument("--json", action="store_true", help="print the status as one JSON document")
    p.set_defaults(func=cmd_status)

    p = _sub(sub, "profiles", "list the built-in serial profiles", """
Prints one line per built-in profile: id, settings, the action on open, and what
the profile is for. Set one with `jupyterlab-device profile <device> <id>`.
""", """
  jupyterlab-device profiles
  jupyterlab-device profiles --json
""")
    p.add_argument("--json", action="store_true", help="print the profiles as one JSON list")
    p.set_defaults(func=cmd_profiles)

    _add_serial_commands(sub)

    p = _sub(sub, "run", "start a tool with the preload shim", """
Starts CMD with a small preloaded library (LD_PRELOAD) that passes the tool's own
DTR and RTS calls, its break, and its parity, data bits and stop bits to the port.
Without it the virtual device refuses the DTR, RTS and break calls and holds no
parity: a tool that asks for parity or 7 data bits gets an error from its settings
call or reads back 8N1, and only the profile of the device supplies them. The
command becomes CMD: output and exit status are the tool's. CMD names the device
by the path that `jupyterlab-device list` prints.

The library is compiled on the first run with the system C compiler (cc or gcc)
into ~/.cache/jupyterlab-device-bridge/ and reused after. Without a compiler the
command exits 1; set a profile instead. A statically linked tool does not load the
library; set a profile for it too.

Before the command becomes CMD it tells the server its process id. So the
Devices panel of the lab (if no sidebar has the panel: menu View, item Show
Devices Panel) lists the run with its command line, and the user can stop it
there. CMD then receives SIGTERM, and SIGKILL 3 s later when it still runs. CMD
starts also when the server does not take the run; the panel then does not list
it.

The command prints nothing of its own on standard output. `jupyterlab-device
shell` starts a shell in which every tool has the library.
""", """
  jupyterlab-device run -- avrdude -c arduino -p m328p \\
      -P /run/devices/tty-2341-0043 -U flash:w:blink.hex
  jupyterlab-device run --device tty-10c4-ea60 -- esptool \\
      --port /run/devices/tty-10c4-ea60 chip-id
""")
    p.usage = f"{PROG} run [-h] [--device D] -- CMD [ARG ...]"
    p.add_argument("--device", metavar="D",
                   help="name of a serial device that must be attached; "
                        "CMD is not started when it is not")
    p.set_defaults(func=cmd_run, command=[])

    p = _sub(sub, "shell", "start a device shell: the shell of the lab's terminals with the preload shim",
             """
Starts the shell command of the lab's terminals with the preloaded library of
`jupyterlab-device run`, and becomes it: a device shell. Every tool started in
that shell passes its own DTR and RTS calls, its break, and its parity, data
bits and stop bits to the port, with no `run --` before it. The Jupyter server
names the shell command, the one that a terminal of the lab starts;
`jupyterlab-device status --json` shows it as `shell`. The variable SHELL is not
read. The command takes no argument.

A device shell is interactive: it is for a person at a terminal and runs until
`exit`. A program without a terminal starts each tool with `jupyterlab-device
run -- CMD` instead.

Before the command becomes the shell it tells the server its process id. So the
Devices panel of the lab (if no sidebar has the panel: menu View, item Show
Devices Panel) lists it as a run, with `jupyterlab-device shell` as its command
line, and the user can stop it there. The shell then receives SIGTERM, and
SIGKILL 3 s later when it still runs.

When standard output is a terminal the command first prints a banner: the
upload tools found on PATH, the attached devices and two commands. With a pipe
or a file as standard output it prints nothing of its own.

Exit status: the status of the shell; 127 when the shell command cannot be
started; 1 without a C compiler for the library, or when the server does not
report the shell command.
""", """
  jupyterlab-device shell
""")
    p.set_defaults(func=cmd_shell)

    p = _sub(sub, "request", "ask the user to grant a device that is not attached", """
Shows a request in the lab with a Grant button and waits. A program cannot grant a
device: the user presses Grant and chooses the device in Chrome's dialog. The
command blocks until then, for at most --timeout seconds.

Prints the name of the granted device on stdout.
Exit status: 0 granted, 1 denied (the reason is on stderr), 2 nobody answered.
""", """
  jupyterlab-device request serial --reason "upload the blink firmware to the Uno"
  jupyterlab-device request usb --vid 0483 --pid 3748 --reason "flash through the ST-Link"
""")
    p.add_argument("kind", choices=("serial", "usb"), help="what to ask for")
    p.add_argument("--vid", type=_usb_id, metavar="HEX",
                   help="USB vendor id that Chrome's dialog is filtered to, for example 2341")
    p.add_argument("--pid", type=_usb_id, metavar="HEX",
                   help="USB product id that Chrome's dialog is filtered to, for example 0043")
    p.add_argument("--reason", required=True, metavar="TEXT",
                   help="why the device is needed; the user reads it next to the Grant button")
    p.add_argument("--timeout", type=float, default=REQUEST_S, metavar="S",
                   help=f"seconds to wait for the user (default {REQUEST_S:g})")
    p.set_defaults(func=cmd_request)

    _add_usb_commands(sub)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the CLI and return its exit status."""
    argv = sys.argv[1:] if argv is None else list(argv)
    parser = build_parser()
    if not argv:
        # A bare call asks what the tool is; the full help answers that.
        parser.print_help(sys.stderr)
        return 2
    # Everything after `--` belongs to the tool that `run` starts.
    command = []
    if argv[0] == "run" and "--" in argv:
        split = argv.index("--")
        argv, command = argv[:split], argv[split + 1:]
    args = parser.parse_args(argv)
    if args.func is cmd_run:
        args.command = command
    try:
        return args.func(DeviceBridgeClient(program=PROG), args)
    except UsageError as error:
        _say(str(error))
        return 2
    except DeviceBridgeError as error:
        _say(_explain(error))
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
