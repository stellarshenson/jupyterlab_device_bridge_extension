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
    jupyterlab-device settings apply tty-2341-0043 arduino-upload
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

from . import __version__, banner, environments, probe, shim_build
from .client import DeviceBridgeClient, DeviceBridgeError
from .serial_settings import ACTIONS

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
    ("pio", "pio run -t upload --upload-port <path>", True),
)
_TOOL_NAMES = [name for name, _, _ in UPLOAD_TOOLS]


def _tools_on_path() -> list[tuple[str, str, bool]]:
    """The known upload tools that PATH holds at this moment, in the order of `UPLOAD_TOOLS`."""
    return [tool for tool in UPLOAD_TOOLS if shutil.which(tool[0])]


def _banner_devices(table: dict) -> list[tuple[str, str, str]]:
    """The devices of the banner for the device table of the server.

    `(kind, name, information)` for each device that is attached and has no error, the serial
    devices first: `COM`, the path, the settings and the action on open of a serial device; `USB`,
    the name, the ids and the product name of a USB device.
    """
    serial = [("COM", record["path"],
               f"{_settings_text(record['settings'])}  on open: {record['configured']['onOpen']}")
              for record in table["serial"] if record["state"] == "attached" and not record["error"]]
    usb = [("USB", record["name"],
            f"{record['vendorId']:04x}:{record['productId']:04x}  {record['productName'] or ''}".rstrip())
           for record in table["usb"] if record["state"] == "attached" and not record["error"]]
    return serial + usb


def _upload_examples() -> str:
    """The end of the top-level help: one example for each known upload tool on PATH now.

    A line of a tool that needs the shim starts with `run --device <name> --`, except inside
    a device shell, where every tool has the shim already.
    """
    prefix = "" if "JUPYTERLAB_DEVICE_SHIM_DIR" in os.environ else f"{PROG} run --device <name> -- "
    lines = [f"  {prefix if shim else ''}{line}" for _, line, shim in _tools_on_path()]
    if not lines:
        return f"No upload tool is on PATH. Known tools: {', '.join(_TOOL_NAMES)}."
    return "\n".join([
        "examples for the upload tools on PATH; <name> is the serial device, as",
        f"`{PROG} list` prints it, and <path> is its path:",
        *lines])


USB_READ_LENGTH = 64

HINTS = {
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
        print(f"serial  {record['name']}  {record['state']}  {record['path']}  "
              f"{_settings_text(record['settings'])}  on open: {record['configured']['onOpen']}  "
              f"config: {record['configName'] or 'custom'}  {held}{error}")
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


def _settings_line(record: dict) -> str:
    return (f"{record['name']}: config {record['configName'] or 'custom'}, "
            f"settings {_settings_text(record['configured'])}, "
            f"on open: {record['configured']['onOpen']}")


def cmd_settings_list(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    configs = bridge.configs()
    if args.json:
        return _print_json(configs)
    for item in configs:
        print(f"{item['name']:<20}{_settings_text(item):<12}"
              f"on open: {item['onOpen']:<16}{'system' if item['system'] else item['id']}")
    return 0


def cmd_settings_show(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    record = bridge.serial(args.device).record()
    if args.json:
        return _print_json(record)
    print(_settings_line(record))
    return 0


def cmd_settings_apply(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    record = bridge.serial(args.device).set_settings(config=args.config)
    print(_settings_line(record))
    return 0


def cmd_settings_set(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    flags = {"baudRate": args.baud, "dataBits": args.data_bits, "parity": args.parity,
             "stopBits": args.stop_bits, "onOpen": args.on_open}
    change = {field: value for field, value in flags.items() if value is not None}
    if not change:
        raise UsageError("give at least one of --baud, --data-bits, --parity, --stop-bits "
                         "and --on-open")
    record = bridge.serial(args.device).set_settings(**change)
    print(_settings_line(record))
    return 0


def cmd_settings_save(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    record = bridge.serial(args.device).record()
    saved = bridge.save_config(args.name, record["configured"])
    print(f"{saved['name']}: saved as {saved['id']}")
    return 0


def cmd_settings_delete(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    bridge.delete_config(args.config)
    print(f"{args.config}: deleted")
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


def _on_a_terminal() -> bool:
    """Standard input and standard error are a terminal: Textual reads keys from the first and draws on the second."""
    return sys.stdin.isatty() and sys.stderr.isatty()


def cmd_terminal(bridge: DeviceBridgeClient, args: argparse.Namespace) -> int:
    record = bridge.serial(args.device).record()
    holder = record["holder"]
    if holder:
        _say(f"{args.device} is held by {holder['name']} (pid {holder['pid']}) - "
             "wait until that program ends or stop it, then run this command again")
        return 1
    if not _on_a_terminal():
        # Without a terminal the app would wait for keys that never come and hold the device.
        raise UsageError("terminal is an app for a person and needs a terminal on standard input and "
                         "standard error; an agent reads with `jupyterlab-device monitor read` and writes "
                         "with `jupyterlab-device monitor write`")
    baud = args.baud or record["settings"]["baudRate"]
    # Imported here: textual takes time to import, and no other command needs it.
    from . import terminal_app, tui_theme

    # The theme is chosen before the app starts: the app owns the terminal after that.
    app = terminal_app.SerialTerminal(bridge, record, baud, tui_theme.pick_theme())
    # The mouse is left to the outer terminal: the lab's xterm.js then selects text and
    # owns the clipboard, and Ctrl+C with no selection still reaches the app.
    app.run(mouse=False)
    return app.return_code or 0


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
        # The image's fish startup file prints its banner only at SHLVL 3 or below; fish raises 3 to 4.
        environment["SHLVL"] = "3"
        # The user chooses the environment of the shell when another environment holds an upload
        # tool and a terminal is on standard input and on standard error, where Textual draws.
        found = []
        if _on_a_terminal():
            found = environments.find(os.getcwd(), _TOOL_NAMES)
        if found or sys.stdout.isatty():
            chosen = environments.current(_TOOL_NAMES)
        if found:
            from . import env_picker  # Textual is loaded only where the selector shows
            chosen = env_picker.choose(chosen, found)
            environment.update(environments.activation(chosen, environment.get("PATH", "")))
    # The server lists this process as a run, so the lab can show it and stop it. The
    # tool starts whatever becomes of that call, and nothing is printed about it. A device
    # shell is listed under its own name: the shell command of a lab can be a start script.
    run = {"pid": os.getpid(), "command": [PROG, "shell"] if device_shell else command}
    if device:
        run["device"] = device
    with contextlib.suppress(Exception):
        bridge.call("POST", "runs", run, timeout=RUN_REGISTER_S)
    if device_shell and sys.stdout.isatty():
        # The devices are read for the banner alone. Without them it has no Devices section.
        devices = None
        with contextlib.suppress(Exception):
            devices = _banner_devices(bridge.call("GET", "devices", timeout=RUN_REGISTER_S))
        text = banner.render(chosen, _TOOL_NAMES, devices, shutil.get_terminal_size().columns, banner.palette())
        # As UTF-8 bytes: a text write fails where the locale has no such characters. Flushed,
        # because the shell replaces this process and what it has not written yet.
        sys.stdout.buffer.write(text.encode())
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
        raise UsageError(f"name the tool after `--`, for example "
                         f"`{PROG} run --device tty-2341-0043 -- avrdude -c arduino ...`")
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
    settings = _sub(sub, "settings", "show and set the serial settings, and manage saved configs", """
A port has one settings record: baud rate, data bits, parity, stop bits and the action
the browser runs when a tool opens the virtual device. The system delivers six
read-only configs; a user-saved config is the values of a port stored under a name. `apply`
copies a config onto a port; `set` changes single fields, which makes the port custom;
`save` stores the current values of a port under a name. A change applies at once.
""", """
  jupyterlab-device settings list
  jupyterlab-device settings show tty-2341-0043
  jupyterlab-device settings apply tty-2341-0043 "Arduino upload"
  jupyterlab-device settings set tty-10c4-ea60 --on-open none --baud 57600
  jupyterlab-device settings save tty-2341-0043 "My Uno"
  jupyterlab-device settings delete "My Uno"
""").add_subparsers(dest="settings_command", required=True, metavar="COMMAND")

    p = _sub(settings, "list", "list the system and saved serial settings configs", """
Prints the six system configs first, then the configs the user saved. A system config cannot
be deleted. The last column is `system` or the id of a saved config.
""", """
  jupyterlab-device settings list
  jupyterlab-device settings list --json
""")
    p.add_argument("--json", action="store_true", help="print the configs as JSON")
    p.set_defaults(func=cmd_settings_list)

    p = _sub(settings, "show", "print the settings of a serial port", """
Prints the config the port uses, or `custom`, and the five values.
""", """
  jupyterlab-device settings show tty-2341-0043
  jupyterlab-device settings show tty-2341-0043 --json
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--json", action="store_true", help="print the device record as JSON")
    p.set_defaults(func=cmd_settings_show)

    p = _sub(settings, "apply", "apply a saved or system config to a serial port", """
Copies all five values of the config onto the port and names the config.
""", """
  jupyterlab-device settings apply tty-2341-0043 "Arduino upload"
  jupyterlab-device settings apply tty-10c4-ea60 esp-upload
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("config", help="name or id of a config, as `settings list` prints it")
    p.set_defaults(func=cmd_settings_apply)

    p = _sub(settings, "set", "change single settings fields of a serial port", """
The port becomes custom: it no longer names a config. At least one field is required.
While a tool holds the device the baud rate is the one the tool sets; a pty cannot
carry parity, data bits or stop bits, so those apply to the browser's port.
""", """
  jupyterlab-device settings set tty-10c4-ea60 --on-open none
  jupyterlab-device settings set tty-0483-5740 --baud 57600 --parity even
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--baud", type=int, metavar="N", help="baud rate while no tool holds the device")
    p.add_argument("--data-bits", type=int, choices=(7, 8), help="data bits")
    p.add_argument("--parity", choices=("none", "even", "odd"), help="parity")
    p.add_argument("--stop-bits", type=int, choices=(1, 2), help="stop bits")
    p.add_argument("--on-open", choices=ACTIONS,
                   help="action the browser runs on the port when a tool opens the device")
    p.set_defaults(func=cmd_settings_set)

    p = _sub(settings, "save", "save the current settings of a port under a name", """
Stores the five values the port uses now as a user-saved config. The name is 1 to 64
characters; a name or id of a system config or of another saved config is refused.
""", """
  jupyterlab-device settings save tty-2341-0043 "My Uno"
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("name", help="name for the saved config, in quotes when it holds spaces")
    p.set_defaults(func=cmd_settings_save)

    p = _sub(settings, "delete", "delete a user-saved config", """
A system config cannot be deleted. A port that uses the config keeps its values and becomes
custom.
""", """
  jupyterlab-device settings delete "My Uno"
""")
    p.add_argument("config", help="name or id of the saved config")
    p.set_defaults(func=cmd_settings_delete)

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

    p = _sub(sub, "terminal", "open the serial terminal app on a serial port, for a person", """
Opens the serial terminal on the device: a full-screen app for a person at a
terminal, not for a script or an agent. Without a terminal on standard input and
standard error it exits with status 2. An agent reads with `jupyterlab-device
monitor read` and writes with `jupyterlab-device monitor write`.

The app shows one line for each line the port sends and for each block that is
sent, with the time, as text or as hex digits. Enter sends the typed line: as
text with the line ending (LF unless the settings say otherwise), or as hex
digits with no line ending. The top row shows the device, its path, the
settings, the DTR and RTS lines and the bytes received (RX) and sent (TX).

keys (the bottom row of the app lists them too):
  Ctrl+Q  quit
  Esc     quit
  Ctrl+O  settings: baud rate, data bits, parity, stop bits, the line ending and
          text or hex for the typed line; Enter applies, Esc cancels
  Ctrl+X  text/hex: show the traffic as text or as hex digits
  Ctrl+P  pause: hold the traffic view; new lines show at the next Ctrl+P
  Ctrl+L  clear: empty the traffic view
  PgUp    scroll up: show earlier lines of the traffic view
  PgDn    scroll down: show later lines of the traffic view
  Up      line up: scroll the traffic view up one line; the mouse wheel sends this
          key
  Down    line down: scroll the traffic view down one line; the mouse wheel sends
          this key
  Ctrl+C  send 0x03: with no text selected, send the byte 0x03; with text selected
          the lab terminal copies it
  Ctrl+Y  keys: a list of every key with what it does; Esc or Ctrl+Y closes it
  Enter   send the typed line

Select text with the mouse and copy it as in any other terminal of the lab: the
lab terminal (xterm.js) owns the selection and the clipboard, so Ctrl+C copies
the selected text and sends no byte, and Ctrl+V pastes the first line of the
clipboard into the send field. Enter then sends that line. While the view is not
paused it returns to the end at each new line: on a port that keeps sending,
press Ctrl+P before you scroll back or select text, and Ctrl+P again to follow
the traffic.

The baud rate is the port's unless --baud is given. The command refuses, with
exit status 1, when another program holds the device, and names that program.
The app opens the device path as every tool does, so this command is the program
that holds the device, and the action on open of the port runs first. Set `--on-open
none` on the port to open the terminal without an action. A setting applied with
Ctrl+O changes the settings of the device. When the port is detached or removed the
app stays open, shows `removed` and sends nothing until the port is attached again;
after Forget, or when the device path failed, it stays removed: quit and start it
again.

Exit status: 0 after Ctrl+Q or Esc; 1 when another program holds the device or
its path cannot be opened; 2 without a terminal.
""", """
  jupyterlab-device terminal tty-2341-0043
  jupyterlab-device terminal tty-2341-0043 --baud 9600
""")
    p.add_argument("device", help="name of the serial device, as `list` prints it")
    p.add_argument("--baud", type=int, metavar="N", help="baud rate (default: the port's)")
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
Runs one action on the port in the browser, now. These are the actions a saved config
may run when a tool opens the device:

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
Every command has its own --help with examples: `{PROG} monitor read --help`,
and `{PROG} help monitor read` prints the same.

quick start, from a board plugged into the user's computer to its output:
  1. The user attaches the board in the panel of the lab named above: the plus
     icon, Connect Serial Port, then the board in Chrome's dialog. A program cannot
     do this; it asks the user with `{PROG} request serial --reason TEXT`.
  2. {PROG} list
     The line of the board holds its name and its path, for example
     tty-2341-0043 and /run/devices/tty-2341-0043.
  3. {PROG} settings apply tty-2341-0043 "Arduino upload"
  4. {PROG} run --device tty-2341-0043 -- pio run -t upload --upload-port /run/devices/tty-2341-0043
     A tool that sets DTR, RTS or parity itself runs under `run`, which names the
     device; without `--device` the command does not start.
  5. {PROG} monitor read tty-2341-0043 --lines 20

agent skill:
  {banner.SKILL} tells an agent how to use this command. The wheel
  installs it at {banner.skill_folder() / "SKILL.md"}
  An agent reads it once its folder is linked into the skills folder of the
  agent, for example:
    mkdir -p ~/.agents/skills && ln -s {banner.skill_folder()} ~/.agents/skills/{banner.SKILL}
    mkdir -p ~/.claude/skills && ln -s {banner.skill_folder()} ~/.claude/skills/{banner.SKILL}

exit status:
  0  done
  1  not done; one line on stderr names the reason and the next step
  2  wrong arguments; for `request`: nobody answered in time
  130  stopped with Ctrl+C
  `run` exits with the status of the tool it started, and with 127 when the tool
  cannot be started; `shell` does the same with the shell; `terminal` exits 0
  after Ctrl+Q or Esc, 1 when the device is held or its path cannot be opened,
  and 2 without a terminal

Results go to stdout and messages to stderr.

The server is the one this lab names: the record whose base URL is
`JUPYTERHUB_SERVICE_PREFIX`, or, when the variable is unset, the only listed server.
Several servers with no match are refused, not guessed. With no matching record the
address is 127.0.0.1 on `JUPYTER_PORT` (default 8888) under the prefix. It is reached
without a proxy.

environment:
  JUPYTERHUB_API_TOKEN, JPY_API_TOKEN  the token; under JupyterHub it outranks the server's own
  JUPYTER_TOKEN                        the token when no record matches
  JUPYTERHUB_SERVICE_PREFIX            which listed server is this lab's; the base path
                                       when no record matches
  JUPYTER_PORT                         the port when no record matches (default 8888)
  NO_COLOR                             when set and not empty, the banner of `shell` has no colour

{_upload_examples()}
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"{PROG} {__version__}")
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    p = _sub(sub, "list", "list the devices with path, state, holder and settings", """
Prints one line per device.

A serial line: `serial`, name, state, path, settings, the action on open and the
config, then the holder. The path is what a serial tool opens. State `attached` means
a lab tab holds the port; on a `detached` device the path still opens but no byte
reaches the board. The config is the name of the config the port uses, or `custom` after
a field was changed with `settings set`. The holder is the program that has the
path open now, or `free`. The line ends with `error: <reason>` for a port that
failed in the browser, for example one the browser could not open, or with
`error: removed` for an unplugged port. The browser does not open a port with
`error: <reason>` again by itself: tell the user the reason and, when the cause is
gone, apply a config again with `jupyterlab-device settings apply <device> <config>`. A
settings change asks the browser to open the port again. Then run `list` again, and
upload only when the line has no `error:`.

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

    _add_serial_commands(sub)

    p = _sub(sub, "run", "start a tool with the preload shim", """
Starts CMD with a small preloaded library (LD_PRELOAD) that passes the tool's own
DTR and RTS calls, its break, and its parity, data bits and stop bits to the port.
Without it the virtual device refuses the DTR, RTS and break calls and holds no
parity: a tool that asks for parity or 7 data bits gets an error from its settings
call or reads back 8N1, and only the port's settings supply them. The
command becomes CMD: output and exit status are the tool's. The run names its
serial device with --device, the name `jupyterlab-device list` prints; CMD names
the same device by the path on that line. Without --device the command does not
start.

The library is compiled on the first run with the system C compiler (cc or gcc)
into ~/.cache/jupyterlab-device-bridge/ and reused after. Without a compiler the
command exits 1; set the settings on the port instead. A statically linked tool
does not load the library; set the settings for it too.

Before the command becomes CMD it tells the server its process id. So the
Devices panel of the lab (if no sidebar has the panel: menu View, item Show
Devices Panel) lists the run with its command line, and the user can stop it
there. CMD then receives SIGHUP, and SIGKILL 3 s later when it still runs. CMD
starts also when the server does not take the run; the panel then does not list
it.

The command prints nothing of its own on standard output. `jupyterlab-device
shell` starts a shell in which every tool has the library.

PlatformIO: pio does not find the virtual device by itself: name its path with
--upload-port for an upload and with --port for pio device monitor, or set
upload_port and monitor_port in platformio.ini. An upload runs under `run --`,
because the upload tool that pio starts sets DTR and RTS itself. pio device
monitor needs no `run --`:

  pio device monitor --port /run/devices/tty-2341-0043 --baud 115200

The two keys in platformio.ini, under the environment of the board:

  [env:uno]
  upload_port = /run/devices/tty-2341-0043
  monitor_port = /run/devices/tty-2341-0043
""", """
  jupyterlab-device run --device tty-2341-0043 -- avrdude -c arduino -p m328p \\
      -P /run/devices/tty-2341-0043 -U flash:w:blink.hex
  jupyterlab-device run --device tty-10c4-ea60 -- esptool \\
      --port /run/devices/tty-10c4-ea60 chip-id
  jupyterlab-device run --device tty-2341-0043 -- pio run -t upload \\
      --upload-port /run/devices/tty-2341-0043
""")
    p.usage = f"{PROG} run [-h] --device D -- CMD [ARG ...]"
    p.add_argument("--device", metavar="D", required=True,
                   help="the serial device the run uses, as `jupyterlab-device list` prints it; "
                        "it must be attached, and the Devices panel lists the run on it "
                        "(if no sidebar has the panel: menu View, item Show Devices Panel)")
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
line, and the user can stop it there. The shell then receives SIGHUP, and
SIGKILL 3 s later when it still runs.

When standard input and standard error are terminals and a conda environment or
the .venv of the start folder, other than the active one, holds an upload tool
(avrdude, stm32flash, esptool, pio), the command first shows a list of the
environments: Enter starts the shell in the highlighted one, Esc keeps the
current one. The shell then has that environment's bin first on PATH and the
variables its activation sets.

When standard output is a terminal the command first prints a banner for the
person: the words DEVICE BRIDGE in block letters, the environment chosen in the
list with its upload tools, the attached devices, where the agent skill is and
whether an agent finds it, and five commands. In the current environment the
tools are those on PATH and in the tool folders of pipx and uv. The banner is
75% of the terminal's width. With a pipe or a file as standard output it prints
nothing of its own.

Exit status: the status of the shell; 127 when the shell command cannot be
started; 1 without a C compiler for the library, or when the server does not
report the shell command.
""", """
  jupyterlab-device shell
""")
    p.set_defaults(func=cmd_shell)

    probe.add_commands(sub, _sub)

    p = _sub(sub, "help", "print the help of the tool or of one command", """
Prints the help of the tool, or of the command that the words name, on stdout:
`jupyterlab-device help monitor read` prints what `jupyterlab-device monitor read
--help` prints. It needs no Jupyter server. Exit status 2 when the words name no
command.
""", """
  jupyterlab-device help
  jupyterlab-device help monitor read
""")
    p.add_argument("words", nargs="*", metavar="COMMAND",
                   help="the words of a command, for example `monitor read`; none for the help of the tool")

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
    if args.command == "help":
        # argparse prints the help of the command that the words name and ends the process
        # there, so no server is looked for. It returns only when a word is `--`.
        parser.parse_args([*args.words, "--help"])
        parser.error("help takes the words of a command, for example `help monitor read`")
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
