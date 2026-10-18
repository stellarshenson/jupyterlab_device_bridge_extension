"""The `probe` commands of `jupyterlab-device`: what is attached to a serial port.

Each probe prints one conclusion and one `next:` command. A tool probe starts its
upload tool through `jupyterlab-device run --device`, so the tool gets the preload
shim and its DTR, RTS and parity calls reach the browser. `probe baud` sets each
rate from 9600 to 230400 on the port, reads the monitor buffer, and restores the
settings record and the open state of the port before it returns.

The `--json` document carries the same fields as the text: `device`, `probe`,
`identified`, `conclusion`, `next` and `details`.
"""

import json
import re
import shutil
import subprocess
import sys
import time

from . import banner
from .client import DeviceBridgeClient, DeviceBridgeError

PROG = "jupyterlab-device"
# The rates that `probe baud` tries, in this order.
BAUD_RATES = (9600, 19200, 38400, 57600, 74880, 115200, 230400)
# Seconds the sweep gives the browser to reopen at a rate, and seconds it reads the
# monitor buffer at that rate.
BAUD_SETTLE_S = 0.05
BAUD_WINDOW_S = 0.4
# Seconds the sweep waits for the port to report itself open again after the restore.
RESTORE_S = 2.0
# Seconds a tool probe waits for the upload tool.
TOOL_TIMEOUT_S = 60.0
# A window is readable when this share of its bytes is printable text, and when it
# holds at least this many printable bytes.
READABLE_SHARE = 0.8
MIN_READABLE = 3
# The ATmega328P signature 0x1e, 0x95, 0x0f, as avrdude prints it.
ATMEGA328P = "1e950f"
TOOLS = {"avr": "avrdude", "stm32": "stm32flash", "esp": "esptool"}
INSTALLERS = {"avr": "firmware-avr.py", "stm32": "firmware-stm32.py", "esp": "firmware-esp.py"}
# The Python module that `run` is: a child found through the interpreter of this
# command, so a PATH without the console script still starts the same CLI.
RUN = [sys.executable, "-m", "jupyterlab_device_bridge_extension.cli", "run"]


class _Refusal(Exception):
    """A probe that cannot start, with the document of its failure and its exit status."""

    def __init__(self, status: int, document: dict) -> None:
        super().__init__(document["conclusion"])
        self.status = status
        self.document = document


def _document(device, probe: str, identified: bool, conclusion: str, next_command: str,
              details: dict) -> dict:
    """The one document of a probe run, for the text and for `--json`."""
    return {"device": device, "probe": probe, "identified": identified,
            "conclusion": conclusion, "next": next_command, "details": details}


def _report(document: dict, as_json: bool, status: int) -> int:
    """Print the conclusion and the next step, or the JSON document, and return the status."""
    if as_json:
        print(json.dumps(document, indent=2))
    else:
        print(document["conclusion"])
        print(f"next: {document['next']}")
    return status


def _failed(device, probe: str, conclusion: str, next_command: str, details: dict) -> dict:
    return _document(device, probe, False, conclusion, next_command, details)


def _attached_serial(bridge: DeviceBridgeClient) -> list[dict]:
    """The serial devices that a lab tab holds, in the order of the server's table."""
    return [record for record in bridge.devices()["serial"] if record["state"] == "attached"]


def _config_command(record: dict) -> str:
    """A `settings apply` line for a record: the config it uses, else the monitor config."""
    return f"{PROG} settings apply {record['name']} {record['config'] or 'monitor'}"


def _resolve(bridge: DeviceBridgeClient, device: str | None, probe: str) -> dict:
    """The record of the port this probe reads.

    Raises:
        _Refusal: no attached port, several attached ports, an unknown name, a detached
            port, or a port whose browser error stops it.
        DeviceBridgeError: the server did not answer.
    """
    if device is None:
        attached = _attached_serial(bridge)
        if not attached:
            next_command = (f'{PROG} request serial --reason '
                            f'"attach the serial device for probe {probe}"')
            apply = f"{PROG} settings apply <name> monitor"
            conclusion = (f"no serial device is attached; ask the user to attach it with "
                          f"{next_command}, then apply a config with {apply}")
            raise _Refusal(1, _failed(None, probe, conclusion, next_command, {"attached": []}))
        if len(attached) > 1:
            names = ", ".join(record["name"] for record in attached)
            next_command = f"{PROG} list"
            conclusion = (f"{len(attached)} serial devices are attached: {names}; name one with "
                          f"`{PROG} probe {probe} <name>`")
            raise _Refusal(2, _failed(None, probe, conclusion, next_command,
                                      {"attached": [record["name"] for record in attached]}))
        record = attached[0]
    else:
        record = bridge.serial(device).record()
        if record["state"] != "attached":
            next_command = (f'{PROG} request serial --reason '
                            f'"attach {record["name"]} for probe {probe}"')
            conclusion = (f"{record['name']} is detached: no lab tab holds it; reattach it with "
                          f"{next_command}, then apply the config with {_config_command(record)}")
            raise _Refusal(1, _failed(record["name"], probe, conclusion, next_command,
                                      {"state": record["state"]}))
    if record["error"]:
        next_command = _config_command(record)
        conclusion = (f"{record['name']} failed in the browser: {record['error']}; "
                      f"open the port again with {next_command}")
        raise _Refusal(1, _failed(record["name"], probe, conclusion, next_command,
                                  {"error": record["error"]}))
    return record


def _tool_command(probe: str, path: str) -> list[str]:
    """The words of the upload tool that identify the board."""
    if probe == "avr":
        return ["avrdude", "-c", "arduino", "-p", "atmega328p", "-b", "115200",
                "-P", path, "-U", "signature:r:-:h"]
    if probe == "stm32":
        # The pty carries no parity, so stm32flash is told 8n1 and does not set 8e1.
        return ["stm32flash", "-b", "115200", "-m", "8n1", path]
    return ["esptool", "--port", path, "chip-id"]


def _upload_command(probe: str, record: dict) -> str:
    """The upload form of the board this probe identified, under `run --device`."""
    name, path = record["name"], record["path"]
    if probe == "avr":
        return (f"{PROG} run --device {name} -- avrdude -c arduino -p atmega328p "
                f"-b 115200 -P {path} -U flash:w:firmware.hex:i")
    if probe == "stm32":
        return (f"{PROG} run --device {name} -- stm32flash -b 115200 -m 8n1 "
                f"-w firmware.bin -v -g 0x0 {path}")
    return f"{PROG} run --device {name} -- esptool --port {path} write-flash 0x0 firmware.bin"


def _installer(probe: str) -> str:
    """The installer script in envs beside the agent skill, which makes the tool available."""
    return str(banner.skill_folder() / "envs" / INSTALLERS[probe])


def _missing_tool(record: dict, probe: str) -> dict:
    tool = TOOLS[probe]
    installer = _installer(probe)
    next_command = f"{PROG} run --device {record['name']} -- {installer}"
    conclusion = (f"{record['name']}: {tool} is not on PATH; install it with {installer}, "
                  "the script in envs beside the agent skill")
    return _failed(record["name"], probe, conclusion, next_command,
                   {"tool": tool, "installer": installer})


def _signature(output: str) -> str | None:
    """The AVR signature in avrdude's output, as six lowercase hexadecimal digits."""
    match = re.search(r"Device signature = (?:0x)?([0-9a-fA-F]{6})", output)
    if match is None:
        match = re.search(r"(?m)^\s*([0-9a-fA-F]{6})\s*$", output)
    return match.group(1).lower() if match else None


def _avr(record: dict, status: int, output: str, details: dict) -> dict:
    signature = _signature(output)
    details["exit"] = status
    if signature is None:
        conclusion = (f"{record['name']}: avrdude read no signature (exit status {status}); "
                      f"read what the board sent with {PROG} monitor read {record['name']} --lines 20")
        next_command = f"{PROG} monitor read {record['name']} --lines 20"
        return _failed(record["name"], "avr", conclusion, next_command, details)
    details.update(signature=signature, expected=ATMEGA328P)
    if signature != ATMEGA328P:
        conclusion = (f"{record['name']}: an AVR answered with signature {signature}, not the "
                      f"ATmega328P signature {ATMEGA328P}")
        next_command = f"{PROG} monitor read {record['name']} --lines 20"
        return _failed(record["name"], "avr", conclusion, next_command, details)
    conclusion = f"{record['name']}: ATmega328P, signature 1e 95 0f"
    return _document(record["name"], "avr", True, conclusion,
                     _upload_command("avr", record), details)


def _stm32(record: dict, status: int, output: str, details: dict) -> dict:
    match = re.search(r"Device ID\s*:\s*(0x[0-9a-fA-F]+)(?:\s*\(([^)]*)\))?", output)
    version = re.search(r"Version\s*:\s*(0x[0-9a-fA-F]+)", output)
    details["exit"] = status
    if match is None:
        conclusion = (f"{record['name']}: no STM32 bootloader answer (exit status {status}); "
                      "BOOT0 must be high at reset and the board restarted to enter the bootloader")
        next_command = f"{PROG} probe stm32 {record['name']}"
        return _failed(record["name"], "stm32", conclusion, next_command, details)
    device_id, description = match.group(1), match.group(2) or "unknown device"
    details.update(deviceId=device_id, description=description,
                   version=version.group(1) if version else None)
    conclusion = (f"{record['name']}: STM32 bootloader answered: device id {device_id} "
                  f"({description}); BOOT0 must be high at reset and the board restarted "
                  "to enter the bootloader")
    return _document(record["name"], "stm32", True, conclusion,
                     _upload_command("stm32", record), details)


def _esp(record: dict, status: int, output: str, details: dict) -> dict:
    match = re.search(r"(?m)^(?:Chip is|Chip type:)\s*(.+)$", output)
    if match is None:
        match = re.search(r"Detecting chip type\.\.\.\s*(\S+)", output)
    details["exit"] = status
    if match is None:
        conclusion = (f"{record['name']}: no ESP chip answered (exit status {status}); "
                      "hold BOOT, tap RESET and run the probe again to enter the bootloader")
        next_command = f"{PROG} probe esp {record['name']}"
        return _failed(record["name"], "esp", conclusion, next_command, details)
    chip = match.group(1).strip()
    details["chip"] = chip
    conclusion = f"{record['name']}: ESP chip answered: {chip}"
    return _document(record["name"], "esp", True, conclusion,
                     _upload_command("esp", record), details)


INTERPRETERS = {"avr": _avr, "stm32": _stm32, "esp": _esp}


def _tool_probe(bridge: DeviceBridgeClient, device: str | None, probe: str) -> dict:
    """Run the upload tool of one board family through `run --device` and read its output."""
    record = _resolve(bridge, device, probe)
    tool = TOOLS[probe]
    if shutil.which(tool) is None:
        return _missing_tool(record, probe)
    command = _tool_command(probe, record["path"])
    details = {"command": [PROG, "run", "--device", record["name"], "--", *command]}
    child = [*RUN, "--device", record["name"], "--", *command]
    try:
        result = subprocess.run(child, capture_output=True, text=True, timeout=TOOL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        conclusion = (f"{record['name']}: {tool} did not answer within {TOOL_TIMEOUT_S:g} s; "
                      f"run the probe again when the board is in its bootloader")
        return _failed(record["name"], probe, conclusion,
                       f"{PROG} probe {probe} {record['name']}", details)
    except OSError as error:
        conclusion = (f"{record['name']}: {tool} could not be started: {error}; "
                      f"check the server with {PROG} status")
        return _failed(record["name"], probe, conclusion, f"{PROG} status", details)
    output = f"{result.stdout}\n{result.stderr}"
    return INTERPRETERS[probe](record, result.returncode, output, details)


def _printable(data: bytes) -> int:
    """The bytes of a window that are text: tab, line feed, carriage return, or printable ASCII."""
    return sum(1 for byte in data if byte in (9, 10, 13) or 32 <= byte <= 126)


def _readable(data: bytes) -> bool:
    printable = _printable(data)
    return printable >= MIN_READABLE and printable >= READABLE_SHARE * len(data)


def _restore(port, before: dict) -> None:
    """Put back the configured values of the port, and wait for its open state.

    Raises:
        DeviceBridgeError: The settings could not be put back.
    """
    if before["config"]:
        try:
            port.set_settings(config=before["config"])
        except DeviceBridgeError:
            # The config is gone; the five values still restore the port.
            port.set_settings(**before["configured"])
    else:
        port.set_settings(**before["configured"])
    if before["portState"] != "open":
        return
    deadline = time.monotonic() + RESTORE_S
    while time.monotonic() < deadline:
        state = port.record()["portState"]
        if state == "open":
            return
        time.sleep(0.02)
    raise DeviceBridgeError(
        None, f"the port stayed {state}, not open, after the settings were put back")


def _baud_probe(bridge: DeviceBridgeClient, device: str | None) -> dict:
    """Set each rate on the port, read its monitor window, and put the port back."""
    record = _resolve(bridge, device, "baud")
    port = bridge.serial(record["name"])
    before = record
    offset = port.monitor()["next"]
    rates = []
    failure = None
    restore_error = None
    try:
        for rate in BAUD_RATES:
            port.set_settings(baudRate=rate)
            time.sleep(BAUD_SETTLE_S)
            chunk = port.monitor(since=offset, wait=BAUD_WINDOW_S)
            data = chunk["data"]
            offset = chunk["next"]
            # Take what reached the buffer while this read ran, too.
            rest = port.monitor(since=offset, wait=0)
            data += rest["data"]
            offset = rest["next"]
            printable = _printable(data)
            rates.append({"baudRate": rate, "bytes": len(data), "printable": printable,
                          "readable": _readable(data)})
    except DeviceBridgeError as error:
        failure = error
    finally:
        try:
            _restore(port, before)
        except DeviceBridgeError as error:
            restore_error = error
    details = {"rates": rates, "restored": restore_error is None,
               "before": {"configured": before["configured"], "portState": before["portState"]}}
    if failure is not None:
        conclusion = (f"{record['name']}: the sweep stopped: {failure}; "
                      f"run {PROG} list to see the device")
        return _failed(record["name"], "baud", conclusion, f"{PROG} list", details)
    if restore_error is not None:
        details["restoreError"] = str(restore_error)
        conclusion = (f"{record['name']}: the sweep ended, but the settings were not put back: "
                      f"{restore_error}; apply a config with {_config_command(before)}")
        return _failed(record["name"], "baud", conclusion, _config_command(before), details)
    readable = [entry for entry in rates if entry["readable"]]
    if not readable:
        conclusion = (f"{record['name']}: no readable output at any of "
                      f"{', '.join(str(rate) for rate in BAUD_RATES)} baud")
        return _failed(record["name"], "baud", conclusion,
                       f"{PROG} monitor read {record['name']} --lines 20", details)
    best = max(readable, key=lambda entry: entry["printable"])
    details["readableRate"] = best["baudRate"]
    conclusion = (f"{record['name']}: readable output at {best['baudRate']} baud "
                  f"({best['printable']} of {best['bytes']} bytes printable)")
    return _document(record["name"], "baud", True, conclusion,
                     f"{PROG} settings set {record['name']} --baud {best['baudRate']}", details)


def cmd_probe(bridge: DeviceBridgeClient, args) -> int:
    """Run one probe and print its document; 0 identified, 1 not, 2 wrong arguments."""
    try:
        if args.probe_name == "baud":
            document = _baud_probe(bridge, args.device)
        else:
            document = _tool_probe(bridge, args.device, args.probe_name)
    except _Refusal as refusal:
        return _report(refusal.document, args.json, refusal.status)
    except DeviceBridgeError as error:
        next_command = f"{PROG} list" if error.status == 404 else f"{PROG} status"
        conclusion = (f"{args.device or 'the serial port'}: the probe did not run: {error}; "
                      f"go on with {next_command}")
        return _report(_failed(args.device, args.probe_name, conclusion, next_command,
                               {"error": str(error)}), args.json, 1)
    return _report(document, args.json, 0 if document["identified"] else 1)


def add_commands(sub, sub_parser) -> None:
    """Add `probe` with its four probes; `sub_parser` is the CLI's `_sub` helper."""
    group = sub_parser(sub, "probe", "find out what is attached to a serial port", """
Runs one test on an attached serial port and prints one conclusion and one `next:`
command. DEVICE is the name that `jupyterlab-device list` prints. With no DEVICE and
exactly one attached serial port the probe uses it; with several attached ports it
refuses and lists their names.

probe baud sets each rate from 9600 to 230400 on the port, reads the monitor buffer
at that rate, and restores the settings record and the open state of the port before
it returns. probe avr reads the AVR signature with avrdude, probe stm32 reads the
device id with stm32flash, and probe esp reads the chip with esptool. A tool probe
starts its tool under `jupyterlab-device run --device`, so the tool gets the preload
shim. A tool that is not on PATH is a failure whose next step names the installer
script in envs beside the agent skill.

Exit status: 0 identified, 1 not identified, 2 wrong arguments. `--json` prints one
document with the fields device, probe, identified, conclusion, next and details;
its conclusion and next are the same as the two text lines.
""", """
  jupyterlab-device probe baud tty-2341-0043
  jupyterlab-device probe avr tty-2341-0043
  jupyterlab-device probe stm32 tty-10c4-ea60 --json
  jupyterlab-device probe esp tty-10c4-ea60
""").add_subparsers(dest="probe_command", required=True, metavar="PROBE")
    probes = (
        ("baud", "find the baud rate at which the port sends readable text", """
Sets each rate from 9600 to 230400 on the port for a moment and reads the monitor
buffer at that rate. A rate is readable when at least 80 percent of the bytes read
there are printable text. The command then puts back the configured values and the
open state of the port, also when no rate is readable or the sweep stops. Prints the
readable rate; the next step applies it with `settings set --baud`.

Exit status: 0 a readable rate was found, 1 none was, 2 wrong arguments.
""", """
  jupyterlab-device probe baud tty-2341-0043
  jupyterlab-device probe baud tty-2341-0043 --json
"""),
        ("avr", "read the AVR signature of the board with avrdude", """
Starts avrdude with `-c arduino -p atmega328p -b 115200`, the port's path as `-P`,
and `-U signature:r:-:h`, through `jupyterlab-device run --device`, so avrdude gets
the preload shim. The ATmega328P signature is 1e950f. On a match the next step is
the upload form of the port; avrdude must be on PATH.

Exit status: 0 an ATmega328P signature was read, 1 it was not, 2 wrong arguments.
""", """
  jupyterlab-device probe avr tty-2341-0043
  jupyterlab-device probe avr tty-2341-0043 --json
"""),
        ("stm32", "read the device id of the STM32 bootloader with stm32flash", """
Starts stm32flash with `-b 115200 -m 8n1` and the port's path, through
`jupyterlab-device run --device`. The mode is 8n1 because the virtual serial device
carries no parity; the STM32 bootloader itself answers 8e1, which the bridge cannot
pass. BOOT0 must be high at reset and the board restarted to enter the bootloader.
On an answer the next step is the upload form of the port; stm32flash must be on
PATH.

Exit status: 0 the bootloader answered, 1 it did not, 2 wrong arguments.
""", """
  jupyterlab-device probe stm32 tty-10c4-ea60
  jupyterlab-device probe stm32 tty-10c4-ea60 --json
"""),
        ("esp", "read the chip of the ESP bootloader with esptool", """
Starts esptool with `chip-id` and the port's path as `--port`, through
`jupyterlab-device run --device`, so esptool gets the preload shim for its DTR and
RTS sequence. When the board does not answer, hold BOOT, tap RESET and run the
probe again. On an answer the next step is the upload form of the port; esptool
must be on PATH.

Exit status: 0 an ESP chip answered, 1 none did, 2 wrong arguments.
""", """
  jupyterlab-device probe esp tty-10c4-ea60
  jupyterlab-device probe esp tty-10c4-ea60 --json
"""),
    )
    for name, help_, description, examples in probes:
        parser = sub_parser(group, name, help_, description, examples)
        parser.add_argument("device", nargs="?",
                            help="name of the serial device, as `jupyterlab-device list` prints it; "
                                 "when omitted with exactly one attached serial device, that device")
        parser.add_argument("--json", action="store_true",
                            help="print one JSON document instead of the conclusion and next lines")
        parser.set_defaults(func=cmd_probe, probe_name=name)
