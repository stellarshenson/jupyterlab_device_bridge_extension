"""Tests of the `jupyterlab-device` CLI.

The command runs as a child process, as a program in a lab terminal runs it, against
the test server and the browser tab double. It finds the test server through the `lab`
environment of `test_client.py`.
"""

import argparse
import ast
import asyncio
import base64
import importlib
import importlib.metadata
import json
import os
import pty
import re
import shlex
import sys
import time
import tomllib
from typing import NamedTuple

import pytest

from jupyterlab_device_bridge_extension import cli
from jupyterlab_device_bridge_extension.tests.fake_tab import (
    DEVICE_DESCRIPTOR,
    SERIAL_NAME,
    USB_MANUFACTURER,
    USB_NAME,
    USB_PRODUCT_NAME,
    USB_SERIAL,
)

from .test_client import (  # noqa: F401 - `lab` is a fixture
    REPOSITORY,
    attach_serial,
    attach_usb,
    lab,
    list_server,
)
from .test_manager import HOLD, end, holding, record

MODULE = "jupyterlab_device_bridge_extension.cli"
SCRIPTS = {"jupyterlab-device": f"{MODULE}:main"}
# How a text of the CLI says where the Devices panel is; the panel is hidden by default.
VIEW_ITEM = "(if no sidebar has the panel: menu View, item Show Devices Panel)"

# The CLI with `os.execv` replaced: it prints what the process would become and exits 0.
EXEC_RECORDED = """
import json, os, sys
from jupyterlab_device_bridge_extension import cli

def record(path, argv):
    print(json.dumps([path, argv]))
    raise SystemExit(0)

os.execv = record
raise SystemExit(cli.main(sys.argv[1:]))
"""

SERIAL_FIELDS = {"name", "path", "state", "portState", "tab", "holder", "settings", "profile",
                 "overrides", "signals", "rx", "tx", "vendorId", "productId", "error"}
USB_FIELDS = {"name", "state", "tab", "vendorId", "productId", "productName", "manufacturerName",
              "serialNumber", "opened", "holder", "rx", "tx", "error"}
# The command table of docs/design.md.
COMMANDS = {
    "list", "status", "profiles", "profile", "monitor read", "monitor write", "terminal", "signals",
    "action", "run", "request", "usb list", "usb describe", "usb open", "usb close", "usb claim",
    "usb release", "usb configuration", "usb alternate", "usb clear-halt", "usb reset", "usb control",
    "usb transfer",
}


class Outcome(NamedTuple):
    """How one run of the CLI ended."""

    status: int
    out: bytes
    err: str


class Cli:
    """The CLI as a child process: `await cli_run("list", "--json")` runs it to its end.

    Attributes:
        binaries: The directory of the private `jupyter` command, first on PATH.
        children: Every process started.
    """

    def __init__(self, binaries):
        self.binaries = binaries
        self.children = []

    def server_list(self, record):
        """Make `jupyter server list` print this server record; None for no server at all."""
        list_server(self.binaries, record)

    async def start(self, *arguments, launch=("-m", MODULE), **streams):
        """Start `python LAUNCH ARGUMENTS` and return the running process, pipes on stdout and stderr."""
        streams = {"stdin": asyncio.subprocess.DEVNULL, "stdout": asyncio.subprocess.PIPE,
                   "stderr": asyncio.subprocess.PIPE, **streams}
        self.children.append(await asyncio.create_subprocess_exec(
            sys.executable, *launch, *map(str, arguments), **streams))
        return self.children[-1]

    async def __call__(self, *arguments, stdin=None, **options):
        """Run the CLI with these arguments and wait for its end; `stdin` is the bytes it reads."""
        if stdin is not None:
            options["stdin"] = asyncio.subprocess.PIPE
        child = await self.start(*arguments, **options)
        out, err = await asyncio.wait_for(child.communicate(stdin), 30)
        return Outcome(child.returncode, out, err.decode())

    async def exec_recorded(self, *arguments):
        """Run the CLI with `os.execv` replaced; stdout is then `[path, argv]` of the call as JSON."""
        return await self(*arguments, launch=("-c", EXEC_RECORDED))


@pytest.fixture(autouse=True)
def plain_help(monkeypatch):
    """Help as plain text of one width, in this process and in a child process.

    FORCE_COLOR of this workstation makes argparse colour its help, and argparse wraps
    to the width of the terminal that pytest runs in.
    """
    monkeypatch.setenv("PYTHON_COLORS", "0")
    monkeypatch.setenv("COLUMNS", "80")


@pytest.fixture
def cli_run(lab, jp_asyncio_loop):
    """A `Cli` in the `lab` environment. Every child that still runs is killed after the test."""
    runner = Cli(lab)
    yield runner
    for child in runner.children:
        if child.returncode is None:
            child.kill()
            jp_asyncio_loop.run_until_complete(child.wait())


async def port_sends(tab, api, data):
    """The serial port sends bytes; returns once the server's monitor buffer holds them."""
    _, before = await api("GET", "serial", SERIAL_NAME, "monitor")
    await tab.port_sends(SERIAL_NAME, data)
    _, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", since=before["next"], wait=5)
    assert base64.b64decode(chunk["data"]) == data


def project():
    """The `[project]` table of pyproject.toml."""
    return tomllib.loads((REPOSITORY / "pyproject.toml").read_text())["project"]


def program_name(pid):
    """The name the kernel has for a process, which is what the bridge reports for a holder."""
    with open(f"/proc/{pid}/comm") as comm:
        return comm.read().strip()


def parsers(parser, path=()):
    """Every parser of the CLI with the words that select it: the top level, the groups, the commands."""
    yield path, parser
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for name, child in action.choices.items():
                yield from parsers(child, (*path, name))


PARSERS = dict(parsers(cli.build_parser()))
SUBCOMMANDS = [path for path in PARSERS if path]


def examples(parser):
    """The command lines of the `examples:` block of a parser, each as the words after the program name."""
    block = parser.epilog.split("examples:\n", 1)[1].replace("\\\n", " ")
    commands = []
    for line in block.splitlines():
        if cli.PROG in line:
            words = shlex.split(line[line.index(cli.PROG):])[1:]
            # What follows a redirection or a pipe belongs to the shell.
            ends = [words.index(mark) for mark in (">", "|") if mark in words]
            commands.append(words[:min(ends, default=len(words))])
    return commands


# ------------------------------------------------------------------------ the command


def test_acc_cli_80_the_project_declares_one_command():
    """ACC-CLI-80 pyproject.toml declares one console script, `jupyterlab-device`, which is `cli.main`."""
    assert project()["scripts"] == SCRIPTS
    (name, target), = SCRIPTS.items()
    assert importlib.metadata.EntryPoint(name, target, "console_scripts").load() is cli.main


def test_acc_cli_80_the_installed_package_has_one_command():
    """ACC-CLI-80 the installed package has one console script, `jupyterlab-device`, which resolves to `cli:main`."""
    installed = importlib.metadata.distribution("jupyterlab_device_bridge_extension").entry_points

    scripts = installed.select(group="console_scripts")

    assert {script.name: script.value for script in scripts} == SCRIPTS, (
        "the package in this environment was installed before pyproject.toml declared "
        "the command - run make install")
    assert scripts["jupyterlab-device"].load() is cli.main


def test_acc_cli_81_the_commands_are_those_of_the_design():
    """ACC-CLI-81 the CLI has the commands of docs/design.md, and its top-level help has a line for each of the first level."""
    leaves = {" ".join(path) for path, parser in PARSERS.items()
              if not any(other[:len(path)] == path and other != path for other in PARSERS)}
    assert leaves == COMMANDS

    top = PARSERS[()].format_help()
    for path in SUBCOMMANDS:
        if len(path) == 1:
            assert f"\n    {path[0]} " in top
    assert "exit status:" in top and "environment:" in top and "JUPYTERHUB_API_TOKEN" in top


@pytest.mark.parametrize("path", SUBCOMMANDS, ids=" ".join)
def test_acc_cli_81_help_of_every_subcommand(path, capsys):
    """ACC-CLI-81 `--help` of every subcommand exits 0 and prints a description, an example and help for every argument."""
    parser = PARSERS[path]

    with pytest.raises(SystemExit) as stop:
        cli.main([*path, "--help"])
    text = capsys.readouterr().out

    assert stop.value.code == 0
    assert text.startswith(f"usage: {cli.PROG} {' '.join(path)} ")
    assert parser.description and parser.description in text
    assert "\nexamples:\n" in text
    assert examples(parser), "the examples block holds a command line"
    for words in examples(parser):
        assert words[:len(path)] == list(path), "an example shows this command"
    for action in parser._actions:
        if not isinstance(action, argparse._SubParsersAction):
            assert action.help, f"{action.dest} has no help"


@pytest.mark.parametrize("path", SUBCOMMANDS, ids=" ".join)
def test_acc_cli_81_every_example_is_a_command_line_the_parser_accepts(path):
    """ACC-CLI-81 every example in the help of a subcommand names only commands, arguments and flags that exist."""
    for words in examples(PARSERS[path]):
        # What follows `--` is the tool that `run` starts.
        own = words[:words.index("--")] if "--" in words else words
        try:
            cli.build_parser().parse_args(own)
        except SystemExit:
            pytest.fail(f"the parser refuses the example `{shlex.join(words)}`")


async def test_acc_cli_81_help_runs_without_a_server(cli_run, monkeypatch):
    """ACC-CLI-81 the real command prints help with exit 0 where no server answers; a bare call prints it with exit 2."""
    cli_run.server_list(None)
    monkeypatch.setenv("JUPYTER_PORT", "9")

    top = await cli_run("--help")
    nested = await cli_run("monitor", "read", "--help")
    bare = await cli_run()

    assert (top.status, top.err) == (0, "") and top.out.decode() == PARSERS[()].format_help()
    assert (nested.status, nested.err) == (0, "")
    assert nested.out.decode() == PARSERS[("monitor", "read")].format_help()
    assert "\x1b" not in top.out.decode()
    assert (bare.status, bare.out) == (2, b"") and bare.err == top.out.decode()


async def test_acc_cli_82_list_and_status_print_one_json_document(cli_run, fake_tab, bridge_address, device_dir):
    """ACC-CLI-82 `list --json` and `status --json` each print one JSON document with the fields of docs/design.md."""
    tab, path = await attach_serial(fake_tab)
    assert (await tab.claim_usb())["ok"]

    listed = await cli_run("list", "--json")
    status = await cli_run("status", "--json")

    assert (listed.status, listed.err, status.status, status.err) == (0, "", 0, "")
    table = json.loads(listed.out)
    assert set(table) == {"serial", "usb"}
    (serial,), (usb,) = table["serial"], table["usb"]
    assert set(serial) == SERIAL_FIELDS and set(usb) == USB_FIELDS
    assert (serial["name"], serial["path"], serial["state"], serial["holder"]) == (
        SERIAL_NAME, path, "attached", None)
    assert (usb["name"], usb["state"], usb["opened"]) == (USB_NAME, "attached", False)
    document = json.loads(status.out)
    assert set(document) == {"server", "version", "deviceDir", "shimDir", "tabs", "counts"}
    assert document["server"] == bridge_address[0]
    assert (document["deviceDir"], document["shimDir"]) == (device_dir, os.path.join(device_dir, ".shim"))
    (lab_tab,) = document["tabs"]
    assert (lab_tab["tabId"], lab_tab["serial"], lab_tab["usb"]) == ("tab-1", True, True)
    assert document["counts"] == {"serial": 1, "usb": 1, "requests": 0}


async def test_acc_cli_82_list_and_status_in_plain_text(cli_run, fake_tab, tool, bridge_address, device_dir):
    """ACC-CLI-82 without `--json`, `list` prints one line per device with path, state, holder and settings, and `status` the server, the tabs and their interfaces."""
    tab, path = await attach_serial(fake_tab)
    assert (await tab.claim_usb())["ok"]
    holder = await holding(tab, tool, HOLD, path)
    await tab.send({"type": "ping", "t": 1})
    await tab.until(lambda: tab.got("pong"))

    listed = await cli_run("list")
    status = await cli_run("status")
    profiles = await cli_run("profiles")

    assert listed.out.decode().splitlines() == [
        f"serial  {SERIAL_NAME}  attached  {path}  115200 8N1  profile monitor  "
        f"held by {program_name(holder.pid)} (pid {holder.pid})",
        f"usb     {USB_NAME}  attached  cafe:4001  closed  {USB_PRODUCT_NAME}",
    ]
    lines = status.out.decode().splitlines()
    assert lines[0].startswith(f"server: {bridge_address[0]} (device bridge ")
    assert lines[1:5] == [f"device directory: {device_dir}",
                          f"shim directory: {os.path.join(device_dir, '.shim')}",
                          "devices: 1 serial, 1 usb", "pending requests: 0"]
    assert re.fullmatch(r"tab tab-1: Web Serial yes, WebUSB yes, round trip \d+(\.\d+)? ms", lines[5])
    assert len(lines) == 6
    assert (listed.status, status.status, status.err) == (0, 0, "")
    assert [line.split()[0] for line in profiles.out.decode().splitlines()] == [
        "monitor", "arduino-upload", "arduino-isp", "stm32-bootloader", "esp-upload"]
    assert "stm32-bootloader  115200 8E1  on open: none" in profiles.out.decode()
    await end(holder)


async def test_acc_serial_17_list_ends_the_line_of_a_port_in_error_with_the_browsers_reason(cli_run, fake_tab):
    """ACC-SERIAL-17 the line that `list` prints for a port the browser could not open ends with `error:` and the browser's reason text (DEF-SERIAL-4)."""
    tab, path = await attach_serial(fake_tab)
    await tab.send({"type": "serial-state", "name": SERIAL_NAME, "state": "error", "settings": None,
                    "signals": {}, "error": "Failed to open serial port."})
    await tab.until(lambda: record(tab)["portState"] == "error")

    listed = await cli_run("list")

    assert listed.out.decode().splitlines() == [
        f"serial  {SERIAL_NAME}  attached  {path}  115200 8N1  profile monitor  free"
        "  error: Failed to open serial port."]
    assert (listed.status, listed.err) == (0, "")


async def test_acc_cli_125_list_names_an_action_on_open_that_is_not_the_profiles(cli_run, fake_tab):
    """ACC-CLI-125 the line that `list` prints for a port with an action on open of its own, as a default of the lab's settings gives it, has `on open <action>` after the profile; a port with the action of its profile has none."""
    tab = await fake_tab()
    assert (await tab.claim_serial(defaults={"baudRate": 9600, "onOpen": "pulse-dtr"}))["ok"]
    await tab.until(lambda: record(tab)["portState"] == "open")
    start = f"serial  {SERIAL_NAME}  attached  {record(tab)['path']}  "

    by_default = await cli_run("list")
    await cli_run("profile", SERIAL_NAME, "arduino-upload")
    await tab.until(lambda: record(tab)["settings"]["baudRate"] == 115200)
    by_profile = await cli_run("list")
    await cli_run("profile", SERIAL_NAME, "--on-open", "none")
    by_flag = await cli_run("list")

    assert [listed.out.decode().splitlines() for listed in (by_default, by_profile, by_flag)] == [
        [f"{start}9600 8N1  profile monitor  on open pulse-dtr  free"],
        [f"{start}115200 8N1  profile arduino-upload  free"],
        [f"{start}115200 8N1  profile arduino-upload  on open none  free"],
    ]


async def test_acc_serial_17_a_profile_set_asks_the_browser_to_open_a_port_in_error_again(cli_run, fake_tab):
    """ACC-SERIAL-17 `profile <device> <id>` on a port the browser could not open sends one `serial-configure`, and `list` then prints the line without `error:`; `list` and `profile <device>` alone send none."""
    tab, path = await attach_serial(fake_tab)
    await tab.send({"type": "serial-state", "name": SERIAL_NAME, "state": "error", "settings": None,
                    "signals": {}, "error": "Failed to open serial port."})
    await tab.until(lambda: record(tab)["portState"] == "error")
    before = len(tab.got("serial-configure"))

    await cli_run("list")
    await cli_run("profile", SERIAL_NAME)
    looked = len(tab.got("serial-configure")) - before
    changed = await cli_run("profile", SERIAL_NAME, "monitor")
    await tab.until(lambda: record(tab)["portState"] == "open")
    listed = await cli_run("list")

    assert (looked, len(tab.got("serial-configure")) - before, changed.status) == (0, 1, 0)
    assert listed.out.decode().splitlines() == [
        f"serial  {SERIAL_NAME}  attached  {path}  115200 8N1  profile monitor  free"]


async def test_acc_cli_84_no_server(cli_run, monkeypatch):
    """ACC-CLI-84 with no Jupyter server the command exits 1 with one stderr line that says to start JupyterLab."""
    cli_run.server_list(None)
    monkeypatch.setenv("JUPYTER_PORT", "9")

    outcome = await cli_run("list")

    assert (outcome.status, outcome.out) == (1, b"")
    assert outcome.err.startswith(f"{cli.PROG}: cannot reach the Jupyter server at http://127.0.0.1:9 (")
    assert outcome.err.endswith(" - start JupyterLab, or run this command in a terminal of the lab\n")
    assert outcome.err.count("\n") == 1


async def test_acc_cli_84_no_connected_tab(cli_run, fake_tab):
    """ACC-CLI-84 with no lab tab connected the commands exit with one stderr line that says to open the lab and attach the device."""
    nothing = await cli_run("list")
    assert (nothing.status, nothing.out) == (0, b"")
    assert nothing.err == (f"{cli.PROG}: no device is attached - open the Devices panel of the lab "
                           f"{VIEW_ITEM} and add a serial port or a USB device\n")
    status = await cli_run("status")
    assert status.err == (f"{cli.PROG}: no lab tab is connected - open the lab in Chrome or Edge, "
                          "over HTTPS or localhost\n")

    tab, _ = await attach_serial(fake_tab)
    await tab.close()
    outcome = await cli_run("monitor", "write", SERIAL_NAME, "x")

    assert (outcome.status, outcome.out) == (1, b"")
    assert outcome.err == (
        f"{cli.PROG}: {SERIAL_NAME} is detached: no lab tab is connected - open the lab in "
        f"Chrome or Edge and attach the device in the Devices panel {VIEW_ITEM}\n")


async def test_acc_cli_124_the_texts_that_send_the_user_to_the_devices_panel_name_the_view_menu_item(
        cli_run, fake_tab):
    """ACC-CLI-124 the help text, the message of `list` with no device, the hint for a detached device and the message of a request nobody answered each name the View menu item Show Devices Panel, once."""
    top_help = PARSERS[()].format_help()
    nothing = await cli_run("list")
    tab, _ = await attach_serial(fake_tab)
    await tab.close()
    detached = await cli_run("monitor", "write", SERIAL_NAME, "x")
    await fake_tab()
    unanswered = await cli_run("request", "serial", "--reason", "read the log", "--timeout", "1")

    assert (nothing.status, detached.status, unanswered.status) == (0, 1, 2)
    for text in (top_help, nothing.err, detached.err, unanswered.err):
        words = " ".join(text.split())  # the help text breaks its lines
        assert "Devices panel" in words
        assert words.count(VIEW_ITEM) == 1 and words.count("Show Devices Panel") == 1, text


def test_acc_cli_124_every_text_of_the_cli_that_names_the_devices_panel_names_the_view_menu_item():
    """ACC-CLI-124 every text in the source of the CLI that sends the user to the Devices panel names the View menu item, and the source has no character outside ASCII."""
    source = (REPOSITORY / "jupyterlab_device_bridge_extension" / "cli.py").read_text(encoding="utf-8")
    texts = [node.value for node in ast.walk(ast.parse(source))
             if isinstance(node, ast.Constant) and isinstance(node.value, str) and "Devices panel" in node.value]

    assert len(texts) >= 4, "the help text, the hint for a detached device, the message of list and of request"
    for text in texts:
        assert " ".join(text.split()).count(VIEW_ITEM) == 1, text
    assert source.isascii(), "an agent's terminal and a log may not show an arrow"


async def test_acc_cli_84_unknown_device(cli_run, fake_tab):
    """ACC-CLI-84 an unknown device name exits 1 with one stderr line that says to run `list`."""
    await attach_serial(fake_tab)
    hint = f" - run `{cli.PROG} list` for the names of the attached devices\n"

    for command in (("monitor", "read", "tty-none"), ("profile", "tty-none"), ("terminal", "tty-none"),
                    ("signals", "tty-none", "--dtr", "1"), ("usb", "open", USB_NAME),
                    ("monitor", "read", "TTY_wrong")):
        outcome = await cli_run(*command)
        assert (outcome.status, outcome.out) == (1, b""), command
        assert outcome.err.startswith(f"{cli.PROG}: ") and outcome.err.endswith(hint), command
        assert outcome.err.count("\n") == 1, command
    assert outcome.err.startswith(f"{cli.PROG}: a device name is 1 to 64 of the characters")


async def test_acc_cli_84_a_server_without_the_bridge_and_a_refused_token(
        cli_run, bridge_address, jp_http_port, jp_base_url):
    """ACC-CLI-84 a server without the extension and a server that refuses the token each give one line with the next step."""
    cli_run.server_list({"port": jp_http_port, "base_url": "/another/", "token": bridge_address[1]})
    missing = await cli_run("list")
    cli_run.server_list({"port": jp_http_port, "base_url": jp_base_url, "token": "wrong"})
    refused = await cli_run("list")

    assert missing.status == refused.status == 1
    assert missing.err.endswith(
        " - that server has no device bridge; check `jupyter server extension list`\n")
    assert refused.err.endswith(" - the token was refused; run this command in a terminal of the lab\n")
    assert missing.err.count("\n") == refused.err.count("\n") == 1


# ----------------------------------------------------------------------- serial ports


async def test_acc_prof_24_profile_sets_the_profile_and_single_fields(cli_run, fake_tab):
    """ACC-PROF-24 `profile <device> <id> --parity ...` sets the profile and the field; the record and the port have them."""
    tab, _ = await attach_serial(fake_tab)

    changed = await cli_run("profile", SERIAL_NAME, "arduino-isp", "--parity", "even")
    shown = await cli_run("profile", SERIAL_NAME)

    settings = {"baudRate": 19200, "dataBits": 8, "parity": "even", "stopBits": 1}
    line = f"{SERIAL_NAME}: profile arduino-isp, overrides parity=even, settings 19200 8E1, on open none\n"
    assert changed == Outcome(0, line.encode(), "") and shown == changed
    await tab.until(lambda: tab.settings[SERIAL_NAME] == settings)
    assert (record(tab)["profile"], record(tab)["overrides"], record(tab)["settings"]) == (
        "arduino-isp", {"parity": "even"}, settings)

    fields = await cli_run("profile", SERIAL_NAME, "--baud", "57600", "--data-bits", "7", "--stop-bits", "2",
                           "--on-open", "pulse-rts")
    assert fields.out.decode() == (
        f"{SERIAL_NAME}: profile arduino-isp, overrides parity=even, baudRate=57600, dataBits=7, "
        "stopBits=2, onOpen=pulse-rts, settings 57600 7E2, on open pulse-rts\n")
    replaced = await cli_run("profile", SERIAL_NAME, "esp-upload")
    assert replaced.out.decode() == (
        f"{SERIAL_NAME}: profile esp-upload, overrides none, settings 115200 8N1, on open esp-bootloader\n")

    unknown = await cli_run("profile", SERIAL_NAME, "no-such-profile")
    assert unknown.status == 1, "the server's message lists the ids"
    assert unknown.err == (f"{cli.PROG}: profile: 'no-such-profile' is not one of monitor, arduino-upload, "
                           "arduino-isp, stm32-bootloader, esp-upload\n")


async def test_acc_mon_39_monitor_read_prints_what_the_port_sent_before_the_call(cli_run, fake_tab, api):
    """ACC-MON-39 bytes the port sent before the CLI started are printed by `monitor read`, with `--raw` unchanged."""
    tab, _ = await attach_serial(fake_tab)
    await port_sends(tab, api, b"boot\r\nready \xc2\xb5s\n")
    await port_sends(tab, api, bytes(range(256)))

    text = await cli_run("monitor", "read", SERIAL_NAME)
    raw = await cli_run("monitor", "read", SERIAL_NAME, "--raw")

    sent = b"boot\r\nready \xc2\xb5s\n" + bytes(range(256))
    assert raw == Outcome(0, sent, "")
    assert (text.status, text.err) == (0, "")
    assert text.out.decode() == sent.decode("utf-8", "replace")
    assert text.out.startswith("boot\r\nready µs\n".encode())


async def test_acc_mon_41_lines_prints_the_last_lines(cli_run, fake_tab, api):
    """ACC-MON-41 `monitor read --lines N` prints the last N lines of the buffer; an unfinished last line counts."""
    tab, _ = await attach_serial(fake_tab)
    await port_sends(tab, api, b"".join(b"line %d\n" % number for number in range(1, 11)))

    assert (await cli_run("monitor", "read", SERIAL_NAME, "--lines", "3")).out == b"line 8\nline 9\nline 10\n"
    assert (await cli_run("monitor", "read", SERIAL_NAME, "--lines", "0")).out == b""
    assert (await cli_run("monitor", "read", SERIAL_NAME, "--lines", "99")).out.count(b"\n") == 10

    await port_sends(tab, api, b"unfinished")
    assert (await cli_run("monitor", "read", SERIAL_NAME, "--lines", "2")).out == b"line 10\nunfinished"
    assert (await cli_run("monitor", "read", SERIAL_NAME, "--lines", "-1")).status == 2


async def test_acc_mon_42_follow_prints_new_bytes_until_the_timeout(cli_run, fake_tab, api):
    """ACC-MON-42 `monitor read --follow --timeout S` prints bytes as they arrive and exits 0 when the time ends."""
    tab, _ = await attach_serial(fake_tab)
    await port_sends(tab, api, b"old\n")
    child = await cli_run.start("monitor", "read", SERIAL_NAME, "--follow", "--timeout", "2")

    async def next_line():
        return await asyncio.wait_for(child.stdout.readline(), 10)

    assert await next_line() == b"old\n"
    started = time.monotonic()
    await tab.port_sends(SERIAL_NAME, b"one\n")
    assert await next_line() == b"one\n", "printed while the command still follows"
    await tab.port_sends(SERIAL_NAME, b"two\n")
    assert await next_line() == b"two\n"
    assert child.returncode is None

    rest, err = await asyncio.wait_for(child.communicate(), 10)
    assert (child.returncode, rest, err) == (0, b"", b"")
    assert 1.5 < time.monotonic() - started < 6


async def test_acc_mon_43_monitor_write_sends_the_bytes_to_the_port(cli_run, fake_tab):
    """ACC-MON-43 `monitor write` sends the text, the hexadecimal bytes or standard input to the port, unchanged."""
    tab, _ = await attach_serial(fake_tab)
    tab.echo = False

    text = await cli_run("monitor", "write", SERIAL_NAME, "led on", "--newline")
    assert text == Outcome(0, b"", "") and tab.written(SERIAL_NAME) == b"led on\n"
    await cli_run("monitor", "write", SERIAL_NAME, "--hex", "7f 00 a5")
    assert tab.written(SERIAL_NAME) == b"led on\n\x7f\x00\xa5"
    await cli_run("monitor", "write", SERIAL_NAME, stdin=bytes(range(256)))
    assert tab.written(SERIAL_NAME) == b"led on\n\x7f\x00\xa5" + bytes(range(256))

    wrong = await cli_run("monitor", "write", SERIAL_NAME, "--hex", "not hex")
    assert wrong.status == 2 and "hexadecimal" in wrong.err
    assert len(tab.got("serial-write")) == 3


async def test_cli_signals_and_action_reach_the_port(cli_run, fake_tab):
    """`signals` sets the named control lines of the port and `action` runs one action (docs/design.md, CLI table)."""
    tab, _ = await attach_serial(fake_tab)

    assert await cli_run("signals", SERIAL_NAME, "--dtr", "0", "--rts", "1") == Outcome(0, b"", "")
    assert await cli_run("signals", SERIAL_NAME, "--dtr", "1") == Outcome(0, b"", "")
    assert await cli_run("action", SERIAL_NAME, "esp-bootloader") == Outcome(0, b"", "")

    assert [{line: event[line] for line in ("dtr", "rts", "brk") if line in event}
            for event in tab.got("serial-signals")] == [{"dtr": False, "rts": True}, {"dtr": True}]
    assert [event["action"] for event in tab.got("serial-action")] == ["esp-bootloader"]
    assert (await cli_run("signals", SERIAL_NAME)).status == 2
    assert (await cli_run("action", SERIAL_NAME, "explode")).status == 2


# ------------------------------------------------------------------ the serial terminal


async def test_acc_term_108_terminal_becomes_pyserial_miniterm(cli_run, fake_tab):
    """ACC-TERM-108 `terminal` replaces itself with `python -m serial.tools.miniterm <path> <baud>`; pyserial is a dependency of the wheel."""
    _, path = await attach_serial(fake_tab)

    outcome = await cli_run.exec_recorded("terminal", SERIAL_NAME)

    assert outcome.status == 0
    assert json.loads(outcome.out) == [
        sys.executable, [sys.executable, "-m", "serial.tools.miniterm", path, "115200"]]
    assert "Ctrl+] quits" in outcome.err and "Ctrl+T opens its menu" in outcome.err
    assert callable(importlib.import_module("serial.tools.miniterm").main)
    assert any(requirement.startswith("pyserial") for requirement in project()["dependencies"])


async def test_acc_term_108_miniterm_runs_on_the_virtual_device(cli_run, fake_tab):
    """ACC-TERM-108 the real `terminal` command becomes miniterm on the device: it shows what the port sends, sends what is typed, and Ctrl+] ends it."""
    tab, _ = await attach_serial(fake_tab)
    tab.echo = False
    keyboard, terminal = pty.openpty()
    os.set_blocking(keyboard, False)
    child = await cli_run.start("terminal", SERIAL_NAME, stdin=terminal, stdout=terminal, stderr=terminal)
    os.close(terminal)
    screen = b""

    def shows(text):
        nonlocal screen
        try:
            screen += os.read(keyboard, 65536)
        except BlockingIOError:
            pass
        return text in screen

    try:
        await tab.until(lambda: record(tab)["holder"])
        assert record(tab)["holder"]["pid"] == child.pid, "the CLI process itself became the terminal program"
        await tab.until(lambda: shows(b"--- Miniterm on "))
        await tab.port_sends(SERIAL_NAME, b"hello from the board\r\n")
        await tab.until(lambda: shows(b"hello from the board"))
        os.write(keyboard, b"abc")
        await tab.until(lambda: tab.written(SERIAL_NAME) == b"abc")
        os.write(keyboard, b"\x1d")
        assert await asyncio.wait_for(child.wait(), 10) == 0
        await tab.until(lambda: record(tab)["holder"] is None)
    finally:
        os.close(keyboard)


async def test_acc_term_109_terminal_uses_the_profile_baud_or_the_flag(cli_run, fake_tab):
    """ACC-TERM-109 `terminal` starts the terminal program at the profile's baud rate, and at `--baud` when it is given."""
    _, path = await attach_serial(fake_tab)
    assert (await cli_run("profile", SERIAL_NAME, "--baud", "9600")).status == 0

    profile = await cli_run.exec_recorded("terminal", SERIAL_NAME)
    flag = await cli_run.exec_recorded("terminal", SERIAL_NAME, "--baud", "57600")

    assert json.loads(profile.out)[1][-2:] == [path, "9600"]
    assert json.loads(flag.out)[1][-2:] == [path, "57600"]


async def test_acc_term_110_terminal_refuses_a_device_another_program_holds(cli_run, fake_tab, tool):
    """ACC-TERM-110 `terminal` on a device another program holds exits 1, names the program and its pid, and starts nothing."""
    tab, path = await attach_serial(fake_tab)
    holder = await holding(tab, tool, HOLD, path)
    name = program_name(holder.pid)

    outcome = await cli_run.exec_recorded("terminal", SERIAL_NAME)

    assert (outcome.status, outcome.out) == (1, b""), "the terminal program was not started"
    assert outcome.err == (
        f"{cli.PROG}: {SERIAL_NAME} is held by {name} (pid {holder.pid}) - wait until that program "
        "ends or stop it, then run this command again\n")
    await end(holder)


# ------------------------------------------------------------------------------- run


async def test_acc_shim_35_run_starts_the_tool_with_the_shim_and_exits_with_its_status(
        cli_run, fake_tab, device_dir, monkeypatch):
    """ACC-SHIM-35 `run -- CMD` starts CMD with the shim loaded and the shim directory set, and exits with CMD's status."""
    await attach_serial(fake_tab)
    script = 'grep -c devshim /proc/self/maps; echo "$LD_PRELOAD"; echo "$JUPYTERLAB_DEVICE_SHIM_DIR"; exit 7'

    outcome = await cli_run("run", "--", "sh", "-c", script)

    loaded, library, shim_dir = outcome.out.decode().splitlines()
    assert outcome.status == 7
    assert int(loaded) >= 1, "the library is mapped into the tool's process"
    assert library.startswith(os.path.join(os.environ["HOME"], ".cache", "jupyterlab-device-bridge", "devshim-"))
    assert os.path.isfile(library)
    assert shim_dir == os.path.join(device_dir, ".shim")

    monkeypatch.setenv("LD_PRELOAD", library)
    kept = await cli_run("run", "--device", SERIAL_NAME, "--", "sh", "-c", 'echo "$LD_PRELOAD"')
    assert (kept.status, kept.out.decode()) == (0, f"{library}:{library}\n"), "a library preloaded already stays"


async def test_acc_shim_35_run_does_not_start_the_tool_without_its_device(cli_run, fake_tab):
    """ACC-SHIM-35 `run` with no command exits 2; with `--device` it starts nothing when that device is detached or unknown."""
    tab, _ = await attach_serial(fake_tab)
    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")

    empty = await cli_run("run", "--")
    detached = await cli_run("run", "--device", SERIAL_NAME, "--", "sh", "-c", "echo started")
    unknown = await cli_run("run", "--device", "tty-none", "--", "sh", "-c", "echo started")
    missing = await cli_run("run", "--", "no-such-tool-7c1f")

    assert empty.status == 2 and "name the tool after `--`" in empty.err
    assert (detached.status, detached.out) == (1, b"") and f"{SERIAL_NAME} is detached" in detached.err
    assert (unknown.status, unknown.out) == (1, b"")
    assert missing.status == 127 and "cannot start no-such-tool-7c1f" in missing.err


async def test_acc_shim_37_run_without_a_c_compiler_names_profiles(cli_run, fake_tab, monkeypatch):
    """ACC-SHIM-37 without a C compiler `run` exits 1, starts nothing, and says that a profile needs no shim."""
    await attach_serial(fake_tab)
    monkeypatch.setenv("PATH", str(cli_run.binaries))

    outcome = await cli_run("run", "--", "/bin/sh", "-c", "echo started")

    assert (outcome.status, outcome.out) == (1, b"")
    assert outcome.err == (
        f"{cli.PROG}: no C compiler (cc or gcc) is installed, so the preload shim cannot be built - "
        f"set a profile with `{cli.PROG} profile <device> <id>` instead: a profile needs no shim\n")


# ---------------------------------------------------------------------------- requests


async def test_acc_usb_50_request_exits_2_when_nobody_answers(cli_run, fake_tab):
    """ACC-USB-50 `request` with no answer exits 2 at its timeout, and the tab was shown the request."""
    tab = await fake_tab()
    started = time.monotonic()

    outcome = await cli_run("request", "serial", "--reason", "upload the blink firmware", "--timeout", "1")

    assert (outcome.status, outcome.out) == (2, b"")
    assert 1 <= time.monotonic() - started < 6
    assert "nobody answered the request within 1 s" in outcome.err and "press Grant" in outcome.err
    (pending,) = tab.got("requests")[1]["pending"]
    assert {key: pending[key] for key in ("kind", "reason", "program")} == {
        "kind": "serial", "reason": "upload the blink firmware", "program": cli.PROG}
    assert "vendorId" not in pending and "productId" not in pending


async def answered_request(cli_run, tab, result):
    """Run `request usb` with ids, let the tab report `result` for it, and return the pending request and the outcome."""
    child = await cli_run.start("request", "usb", "--vid", "0483", "--pid", "3748", "--reason", "flash")
    (pending,) = await tab.until(lambda: tab.requests["pending"])
    await tab.send({"type": "request-result", "id": pending["id"], **result})
    out, err = await asyncio.wait_for(child.communicate(), 20)
    return pending, Outcome(child.returncode, out, err.decode())


async def test_acc_usb_48_request_prints_the_granted_device_and_exits_0(cli_run, fake_tab):
    """ACC-USB-48 (CLI half) `request` sends the vendor and product filter, and on a grant prints the device's name with exit 0."""
    pending, outcome = await answered_request(cli_run, await fake_tab(), {"ok": True, "name": USB_NAME})

    assert (pending["vendorId"], pending["productId"]) == (0x0483, 0x3748)
    assert (outcome.status, outcome.out) == (0, f"{USB_NAME}\n".encode())


async def test_acc_usb_49_request_exits_1_with_the_reason_when_denied(cli_run, fake_tab):
    """ACC-USB-49 (CLI half) a denied request makes `request` exit 1 with the browser's reason on stderr."""
    _, outcome = await answered_request(cli_run, await fake_tab(), {
        "ok": False, "error": {"name": "NotFoundError", "message": "No device selected."}})

    assert (outcome.status, outcome.out) == (1, b"")
    assert "the request was denied: NotFoundError: No device selected." in outcome.err


# -------------------------------------------------------------------------------- USB


async def test_acc_cli_85_usb_commands_print_the_devices_answers(cli_run, fake_tab):
    """ACC-CLI-85 `usb list`, `describe`, `control` and `transfer` print the device's answers; bytes are hexadecimal."""
    tab = await attach_usb(fake_tab)

    listed = await cli_run("usb", "list")
    described = await cli_run("usb", "describe", USB_NAME)
    assert listed == Outcome(0, f"usb     {USB_NAME}  attached  cafe:4001  closed  {USB_PRODUCT_NAME}\n".encode(), "")
    descriptors = json.loads(described.out)
    endpoints = descriptors["configurations"][0]["interfaces"][0]["alternates"][0]["endpoints"]
    assert [(endpoint["direction"], endpoint["type"]) for endpoint in endpoints] == [("out", "bulk"), ("in", "bulk")]
    assert (descriptors["manufacturerName"], descriptors["productName"], descriptors["serialNumber"]) == (
        USB_MANUFACTURER, USB_PRODUCT_NAME, USB_SERIAL)

    assert await cli_run("usb", "open", USB_NAME) == Outcome(0, b"", "")
    read = await cli_run("usb", "control", USB_NAME, "0x80", "6", "0x0100", "0", "--length", "18")
    assert read == Outcome(0, f"{DEVICE_DESCRIPTOR.hex()}\n".encode(), "")
    assert tab.usb_calls[-1] == ("control-in", {"requestType": "standard", "recipient": "device", "request": 6,
                                                "value": 0x0100, "index": 0, "length": 18})
    written = await cli_run("usb", "control", USB_NAME, "0x40", "1", "2", "3", "--data", "01ff")
    assert written == Outcome(0, b"2\n", "")
    assert tab.usb_calls[-1] == ("control-out", {"requestType": "vendor", "recipient": "device", "request": 1,
                                                 "value": 2, "index": 3, "data": "Af8="})

    assert await cli_run("usb", "claim", USB_NAME, "0") == Outcome(0, b"", "")
    assert await cli_run("usb", "transfer", USB_NAME, "0x01", "--data", "f10100") == Outcome(0, b"3\n", "")
    assert await cli_run("usb", "transfer", USB_NAME, "0x81", "--length", "2") == Outcome(0, b"f101\n", "")
    assert await cli_run("usb", "transfer", USB_NAME, "0x81", "--timeout", "1000") == Outcome(0, b"00\n", "")
    assert tab.usb_calls[-3:] == [
        ("transfer-out", {"endpointNumber": 1, "data": "8QEA"}),
        ("transfer-in", {"endpointNumber": 1, "length": 2, "timeout": 5000}),
        ("transfer-in", {"endpointNumber": 1, "length": 64, "timeout": 1000}),
    ]
    assert (await cli_run("usb", "list")).out.decode().split()[4] == "open"


async def test_acc_panel_112_usb_open_names_the_command_as_the_program(cli_run, fake_tab):
    """ACC-PANEL-112 after `usb open` the USB record names jupyterlab-device as its holder, and after `usb close` it names nobody."""
    tab = await attach_usb(fake_tab)

    assert await cli_run("usb", "open", USB_NAME) == Outcome(0, b"", "")

    # The table with the holder follows the table that only says the device is open.
    await tab.until(lambda: tab.devices["usb"][0]["holder"])
    assert tab.devices["usb"][0]["holder"] == {"name": cli.PROG}
    assert tab.usb_calls == [("open", {})]

    assert await cli_run("usb", "close", USB_NAME) == Outcome(0, b"", "")

    await tab.until(lambda: not tab.devices["usb"][0]["opened"])
    assert tab.devices["usb"][0]["holder"] is None


async def test_acc_cli_85_the_other_usb_operations_reach_the_device(cli_run, fake_tab):
    """ACC-CLI-85 `usb configuration`, `alternate`, `clear-halt`, `release`, `reset` and `close` reach the browser device with their numbers."""
    tab = await attach_usb(fake_tab)

    for command in (("configuration", "1"), ("alternate", "0", "0x01"), ("clear-halt", "0x81"),
                    ("clear-halt", "2"), ("release", "0"), ("reset",), ("close",)):
        assert await cli_run("usb", command[0], USB_NAME, *command[1:]) == Outcome(0, b"", ""), command

    assert tab.usb_calls == [
        ("select-configuration", {"configurationValue": 1}),
        ("select-alternate", {"interfaceNumber": 0, "alternateSetting": 1}),
        ("clear-halt", {"direction": "in", "endpointNumber": 1}),
        ("clear-halt", {"direction": "out", "endpointNumber": 2}),
        ("release-interface", {"interfaceNumber": 0}),
        ("reset", {}),
        ("close", {}),
    ]


async def test_acc_cli_85_the_timeout_of_a_usb_command_ends_the_wait(cli_run, fake_tab):
    """ACC-CLI-85 `--timeout` ends a transfer out, a control transfer in and a control transfer out that the browser does not answer, before the bridge's own 5 s."""
    tab = await attach_usb(fake_tab)
    tab.answers = False

    async def run(*arguments):
        outcome = await cli_run("usb", *arguments)
        return outcome, time.monotonic()

    # The first command has no timeout and waits the bridge's 5 s; all four start together.
    (_, untimed), *timed = await asyncio.gather(
        run("transfer", USB_NAME, "0x01", "--data", "00"),
        run("transfer", USB_NAME, "0x01", "--data", "00", "--timeout", "300"),
        run("control", USB_NAME, "0x80", "6", "0x0100", "0", "--timeout", "300"),
        run("control", USB_NAME, "0x40", "1", "0", "0", "--data", "00", "--timeout", "300"))

    for outcome, ended in timed:
        assert untimed - ended > 2, "ended well before the command without a timeout"
        assert (outcome.status, outcome.out) == (1, b"")
        assert outcome.err == (
            f"{cli.PROG}: the tab did not answer in time - the lab tab did not answer, or the device sent "
            "no data in that time: check that the lab tab is open, then run the command again or give a "
            "USB read a longer --timeout\n")


async def test_acc_cli_85_a_usb_failure_is_one_line_on_stderr(cli_run, fake_tab):
    """ACC-CLI-85 a read without data, a stall, a refusal of the browser and wrong hexadecimal digits each exit non-zero with one line; ACC-USB-60 the refusal has Chrome's name and message."""
    tab = await attach_usb(fake_tab)

    silent = await cli_run("usb", "transfer", USB_NAME, "0x81", "--timeout", "200")
    wrong = await cli_run("usb", "transfer", USB_NAME, "0x01", "--data", "xyz")
    tab.stall = True
    stalled = await cli_run("usb", "transfer", USB_NAME, "0x01", "--data", "00")
    tab.stall = False
    tab.error = ("NetworkError", "Unable to claim interface.")
    refused = await cli_run("usb", "claim", USB_NAME, "0")

    assert (silent.status, silent.out) == (1, b"")
    assert silent.err.endswith(
        " - the lab tab did not answer, or the device sent no data in that time: check that the lab tab "
        "is open, then run the command again or give a USB read a longer --timeout\n")
    assert wrong.status == 2 and "--data is hexadecimal digits" in wrong.err
    assert (stalled.status, stalled.out) == (1, b"") and stalled.err.startswith(f"{cli.PROG}: stall: ")
    assert refused == Outcome(1, b"", f"{cli.PROG}: NetworkError: Unable to claim interface.\n")
