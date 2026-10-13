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
import tornado.web

from jupyterlab_device_bridge_extension import cli, shim_build
from jupyterlab_device_bridge_extension import manager as manager_module
from jupyterlab_device_bridge_extension.manager import BridgeError
from jupyterlab_device_bridge_extension.routes import DevicesHandler, RunsHandler, StatusHandler
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
from .test_readme import command_lines, readme

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
    "action", "run", "shell", "request", "usb list", "usb describe", "usb open", "usb close", "usb claim",
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
    # The top-level help names the upload tools on PATH, so this process and the command get one PATH.
    monkeypatch.setenv("PATH", str(cli_run.binaries))

    top = await cli_run("--help")
    nested = await cli_run("monitor", "read", "--help")
    bare = await cli_run()

    assert (top.status, top.err) == (0, "") and top.out.decode() == cli.build_parser().format_help()
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
    assert set(document) == {"server", "version", "deviceDir", "shimDir", "shell", "tabs", "counts"}
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


def test_acc_cli_151_the_wheel_requires_the_basic_terminal_extension():
    """ACC-CLI-151 pyproject.toml lists `jupyterlab-basic-terminal-extension>=1.0.7,<2` among the dependencies of the project, so pip installs it with the wheel."""
    requirements = [requirement for requirement in project()["dependencies"]
                    if requirement.startswith("jupyterlab-basic-terminal-extension")]

    assert requirements == ["jupyterlab-basic-terminal-extension>=1.0.7,<2"]


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


async def test_def_cli_13_run_with_an_empty_tool_name_says_so_and_exits_127(cli_run, fake_tab):
    """DEF-CLI-13 `run` with an empty word as the tool prints one message and exits 127, as for a tool that does not exist; it prints no traceback."""
    await attach_serial(fake_tab)

    outcome = await cli_run("run", "--", "")

    assert (outcome.status, outcome.out) == (127, b"")
    assert outcome.err.startswith(f"{cli.PROG}: cannot start ") and outcome.err.count("\n") == 1


async def test_acc_shim_37_run_without_a_c_compiler_names_profiles(cli_run, fake_tab, monkeypatch):
    """ACC-SHIM-37 without a C compiler `run` exits 1, starts nothing, and says that a profile needs no shim."""
    await attach_serial(fake_tab)
    monkeypatch.setenv("PATH", str(cli_run.binaries))

    outcome = await cli_run("run", "--", "/bin/sh", "-c", "echo started")

    assert (outcome.status, outcome.out) == (1, b"")
    assert outcome.err == (
        f"{cli.PROG}: no C compiler (cc or gcc) is installed, so the preload shim cannot be built - "
        f"set a profile with `{cli.PROG} profile <device> <id>` instead: a profile needs no shim\n")


# Prints its process id, then waits for a line on stdin.
SAY_PID = "import os, sys; print(os.getpid(), flush=True); sys.stdin.readline()"


async def test_acc_shim_128_run_registers_the_process_it_then_becomes(cli_run, fake_tab, api):
    """ACC-SHIM-128 `run` posts its process id, the words of the tool and its `--device` before it becomes the tool: the run the server lists has the process id of the tool."""
    tab, _ = await attach_serial(fake_tab)
    command = [sys.executable, "-c", SAY_PID]

    child = await cli_run.start("run", "--device", SERIAL_NAME, "--", *command, stdin=asyncio.subprocess.PIPE)
    pid = int(await asyncio.wait_for(child.stdout.readline(), 20))

    assert pid == child.pid, "the CLI process itself became the tool"
    run = {"pid": pid, "program": os.path.basename(sys.executable), "command": " ".join(command)[:200],
           "device": SERIAL_NAME}
    # The tool does not talk to the server, so the run was listed before the tool began.
    assert (await api("GET", "runs")) == (200, {"runs": [run]})
    await tab.until(lambda: tab.runs["running"])
    assert tab.runs == {"type": "runs", "running": [run]}

    await end(child)
    assert child.returncode == 0
    await tab.until(lambda: tab.runs["running"] == [], timeout=2)


async def test_acc_shim_128_run_starts_the_tool_when_the_server_refuses_the_run(
        cli_run, fake_tab, manager, monkeypatch):
    """ACC-SHIM-128 when `POST runs` refuses the run, the tool starts all the same and exits with its own status, and `run` prints nothing about the refusal; a run without `--device` posts no device."""
    await fake_tab()
    asked = []

    def refuse(body):
        asked.append(body)
        raise BridgeError(400, "bad-request", "pid: refused by this test")

    monkeypatch.setattr(manager, "register_run", refuse)
    script = "echo started; exit 7"

    outcome = await cli_run("run", "--", "sh", "-c", script)

    assert asked == [{"pid": cli_run.children[-1].pid, "command": ["sh", "-c", script]}]
    assert outcome == (7, b"started\n", "")


async def test_acc_shim_128_run_starts_the_tool_when_the_server_does_not_answer_within_2_s(
        cli_run, fake_tab, monkeypatch):
    """ACC-SHIM-128 when `POST runs` gives no answer, `run` waits 2 s for it, then starts the tool and prints nothing about it."""
    await fake_tab()
    asked = []
    answer = asyncio.Event()

    async def silent(handler):
        asked.append(time.monotonic())
        await answer.wait()

    monkeypatch.setattr(RunsHandler, "post", silent)

    outcome = await cli_run("run", "--", "sh", "-c", "echo started; exit 7")
    ended = time.monotonic()
    answer.set()
    await asyncio.sleep(0.1)  # the handler ends within the test

    assert outcome == (7, b"started\n", "")
    # 2 s is the time of the registration, 10 s the time of every other call of the CLI.
    assert len(asked) == 1 and 1.8 < ended - asked[0] < 5


# The banner of a device shell, as the criteria and docs/design.md have it: the square wave
# and the name line above the lines of the tools and of the devices; an empty line, the two
# hint lines and the rule under them.
BANNER_TOP = """\
────┐   ┌─┐ ┌─┐   ┌─┐ ┌─┐     ┌───┐   ┌─┐ ┌───────────
    └───┘ └─┘ └───┘ └─┘ └─────┘   └───┘ └─┘
◆ jupyterlab-device                       device shell

"""
BANNER_BOTTOM = """
jupyterlab-device list      all devices
jupyterlab-device --help    example commands
──────────────────────────────────────────────────────"""
NO_DEVICE = "No device is attached."
# The tool line with all three known upload tools on PATH, and the two lines with none of them.
THREE_TOOLS = ("avrdude", "stm32flash", "esptool")
FOR_THREE_TOOLS = ("For avrdude, stm32flash, esptool.",)
NO_TOOL = ("No avrdude, stm32flash or esptool on PATH.", "Install one to make use of the device shell.")


def banner(*device_lines, tools=FOR_THREE_TOOLS):
    """What a terminal gets for the banner with these lines of the tools and of the devices.

    Pale cyan comes before the banner, the colour reset and an empty line after it.
    """
    lines = "".join(f"{line}\n" for line in (*tools, *device_lines))
    return f"\x1b[38;2;159;224;238m{BANNER_TOP}{lines}{BANNER_BOTTOM}\x1b[0m\n\n"


def device_calls(monkeypatch):
    """Record the calls of `GET devices` that the test server gets from now on, one entry for each."""
    asked, get = [], DevicesHandler.get

    def recorded(handler):
        asked.append(handler.request.uri)
        return get(handler)

    monkeypatch.setattr(DevicesHandler, "get", recorded)
    return asked


def stand_in(path):
    """Make a program that prints `started` and ends, in place of a shell that would wait for input."""
    path.write_text("#!/bin/sh\necho started\n")
    path.chmod(0o755)
    return str(path)


class Screen:
    """A terminal for one child process, and what that process displayed on it."""

    def __init__(self):
        self.keyboard, self.terminal = pty.openpty()
        os.set_blocking(self.keyboard, False)
        self.closed = False
        self._bytes = b""

    def displayed(self):
        """What the terminal displayed so far, with the line ends as the programs wrote them."""
        try:
            while chunk := os.read(self.keyboard, 65536):
                self._bytes += chunk
        except BlockingIOError:
            pass  # nothing more for now
        except OSError:
            self.closed = True  # every process has closed the terminal
        return self._bytes.replace(b"\r\n", b"\n").decode()


@pytest.fixture
def upload_tools(cli_run, tmp_path, monkeypatch):
    """Decide which upload tools the CLI finds: `upload_tools("avrdude", "esptool")`.

    The fixture leaves a PATH of two folders: a new one, into which the call puts stand-in
    programs with these names, and the one of the private `jupyter`. So what the machine of
    the test run has installed does not reach the CLI. This PATH holds no C compiler, so the
    shim is built first, with the PATH of the test run.

    Returns:
        The call that adds the programs. It returns the new folder.
    """
    shim_build.build()
    folder = tmp_path / "upload-tools"
    folder.mkdir()
    monkeypatch.setenv("PATH", os.pathsep.join([str(folder), str(cli_run.binaries)]))
    monkeypatch.delenv("JUPYTERLAB_DEVICE_SHIM_DIR", raising=False)

    def install(*names):
        for name in names:
            stand_in(folder / name)
        return folder

    return install


@pytest.fixture
def three_upload_tools(upload_tools):
    """The three known upload tools are on the PATH of the CLI, and nothing else of the machine."""
    upload_tools(*THREE_TOOLS)


def terminal_shell(jp_serverapp, monkeypatch, *words):
    """Make these words the shell command of the terminals of the test server."""
    monkeypatch.setattr(jp_serverapp.web_app.settings["terminal_manager"], "shell_command", list(words))


@pytest.fixture
def lab_shell(jp_serverapp, tmp_path, monkeypatch):
    """The terminals of the test server start one stand-in program, and the CLI has no variable SHELL.

    Returns:
        The path of the stand-in, which prints `started` and ends.
    """
    shell = stand_in(tmp_path / "lab-shell")
    terminal_shell(jp_serverapp, monkeypatch, shell)
    monkeypatch.delenv("SHELL", raising=False)
    return shell


@pytest.fixture
def screen():
    """A `Screen`; `on_a_terminal` runs the CLI on it."""
    made = Screen()
    yield made
    os.close(made.keyboard)


async def on_a_terminal(cli_run, screen, *arguments, streams=("stdin", "stdout")):
    """Run the CLI to its end with the terminal of `screen` as these standard streams.

    Returns:
        The exit status, what the terminal displayed, and `(stdout, stderr)` of the CLI:
        the bytes of a stream that is a pipe, None for a stream that is the terminal.
    """
    try:
        child = await cli_run.start(*arguments, **dict.fromkeys(streams, screen.terminal))
    finally:
        os.close(screen.terminal)
    piped = await asyncio.wait_for(child.communicate(), 30)
    deadline = time.monotonic() + 5
    while not screen.closed:
        assert time.monotonic() < deadline, "a process still has the terminal open"
        screen.displayed()
        await asyncio.sleep(0.01)
    return child.returncode, screen.displayed(), piped


@pytest.mark.usefixtures("three_upload_tools", "lab_shell")
async def test_acc_shim_145_shell_prints_the_banner_on_a_terminal_before_it_becomes_the_shell(
        cli_run, manager, screen, monkeypatch):
    """ACC-SHIM-145 `shell` on a terminal prints the banner in pale cyan, with the colour reset and an empty line after it, after the registration of the run and before the first output of the shell. The CLI has no variable SHELL, and the server of this test has no device."""
    register, at_registration = manager.register_run, []

    def registered(body):
        at_registration.append(screen.displayed())
        return register(body)

    monkeypatch.setattr(manager, "register_run", registered)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner(NO_DEVICE) + "started\n"
    assert at_registration == [""], "the terminal displayed nothing before the run was registered"


@pytest.mark.usefixtures("three_upload_tools", "lab_shell")
async def test_acc_shim_136_the_banner_reaches_the_terminal_where_the_encoding_of_standard_output_lacks_its_characters(
        cli_run, screen, monkeypatch):
    """ACC-SHIM-136 (the banner, which `shell` prints since ACC-SHIM-145) the banner reaches the terminal as UTF-8 and the shell starts, also where Python's encoding of standard output has no character for the wave, the rule and the diamond."""
    monkeypatch.setenv("PYTHONIOENCODING", "ascii")

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner(NO_DEVICE) + "started\n"


@pytest.mark.usefixtures("lab_shell")
async def test_acc_shim_145_shell_prints_no_banner_when_standard_output_is_no_terminal(cli_run, screen):
    """ACC-SHIM-145 `shell` with a pipe as standard output prints nothing of its own and starts the shell, also while standard input and standard error are a terminal."""
    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell", streams=("stdin", "stderr"))

    assert (status, piped) == (0, (b"started\n", None))
    assert displayed == "", "the banner did not go to standard error either"


@pytest.mark.parametrize("tool", ["shell", "other"], ids=["the value of SHELL as its tool", "another tool"])
async def test_acc_shim_145_run_prints_no_banner_on_a_terminal(tool, cli_run, screen, lab_shell, tmp_path, monkeypatch):
    """ACC-SHIM-145 `run` on a terminal prints nothing of its own for any tool: not for the program that the variable SHELL names, which is the shell command of the lab's terminals too, and not for another program."""
    programs = {"shell": lab_shell, "other": stand_in(tmp_path / "tool")}
    monkeypatch.setenv("SHELL", lab_shell)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "run", "--", programs[tool])

    assert (status, piped) == (0, (None, b""))
    assert displayed == "started\n"


def test_acc_shim_145_run_help_says_that_run_prints_nothing_of_its_own():
    """ACC-SHIM-145 `run --help` says that `run` prints nothing of its own, names `shell` for a shell in which every tool has the library, and holds no word about a banner."""
    text = " ".join(PARSERS[("run",)].format_help().split())  # the help text breaks its lines

    assert ("The command prints nothing of its own on standard output. `jupyterlab-device shell` starts "
            "a shell in which every tool has the library.") in text
    assert "banner" not in text


# ---------------------------------------------------------------------- the device shell

# A shell command for the terminals of the test server. It prints its process id, its words,
# whether the shim is in its memory, and the two variables of the shim, then ends with status 7.
# It uses only what `sh` has built in, so it needs no program of PATH.
REPORTING_SHELL = """#!/bin/sh
shim=no
while read -r line; do
    case "$line" in *devshim-*) shim=yes;; esac
done < /proc/$$/maps
echo "pid $$"
echo "words $*"
echo "shim $shim"
echo "preload $LD_PRELOAD"
echo "directory $JUPYTERLAB_DEVICE_SHIM_DIR"
exit 7
"""


@pytest.mark.parametrize("variable", [False, True], ids=["no variable SHELL", "SHELL names another program"])
async def test_acc_cli_144_shell_becomes_the_shell_command_of_the_lab_terminals_with_the_shim(
        variable, cli_run, manager, jp_serverapp, screen, device_dir, tmp_path, monkeypatch):
    """ACC-CLI-144 `shell` on a terminal becomes the shell command that `GET status` reports, every word of it, with the shim loaded and both variables of the shim set, and exits with its status; before that it registers its process id as a run with the command `jupyterlab-device shell`. It does not start what the variable SHELL names."""
    launcher = tmp_path / "launch-shell.sh"
    launcher.write_text(REPORTING_SHELL)
    launcher.chmod(0o755)
    terminal_shell(jp_serverapp, monkeypatch, str(launcher), "--login")
    monkeypatch.delenv("SHELL", raising=False)
    if variable:
        monkeypatch.setenv("SHELL", stand_in(tmp_path / "other-shell"))
    register, registered = manager.register_run, []

    def recorded(body):
        registered.append((body, register(body)))
        return registered[-1][1]

    monkeypatch.setattr(manager, "register_run", recorded)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    pid = cli_run.children[-1].pid
    report = dict(line.split(" ", 1) for line in displayed.split("\n")
                  if line.startswith(("pid ", "words ", "shim ", "preload ", "directory ")))
    assert (status, piped) == (7, (None, b""))
    assert report == {"pid": str(pid), "words": "--login", "shim": "yes", "preload": str(shim_build.build()),
                      "directory": os.path.join(device_dir, ".shim")}
    assert "started" not in displayed, "the program that SHELL names did not start"
    assert registered == [({"pid": pid, "command": ["jupyterlab-device", "shell"]},
                           {"pid": pid, "program": "jupyterlab-device", "command": "jupyterlab-device shell",
                            "device": None})]


@pytest.mark.parametrize("words", [("bash",), ("--device", SERIAL_NAME), ("--", "bash")], ids=" ".join)
async def test_acc_cli_144_shell_takes_no_argument(words, cli_run, lab_shell):
    """ACC-CLI-144 `shell` with a word, with `--device` or with `--` and a tool after it exits 2, names the words it does not take on stderr, and starts no shell."""
    outcome = await cli_run("shell", *words)

    assert (outcome.status, outcome.out) == (2, b"")
    assert outcome.err.endswith(f"{cli.PROG}: error: unrecognized arguments: {' '.join(words)}\n")


async def test_acc_cli_144_shell_exits_127_when_the_shell_command_cannot_be_started(
        cli_run, jp_serverapp, tmp_path, monkeypatch):
    """ACC-CLI-144 when the shell command of the lab's terminals cannot be started, `shell` exits 127, as `run` does for its tool, with one line that names the command and where the server shows it."""
    missing = str(tmp_path / "no-such-shell")
    terminal_shell(jp_serverapp, monkeypatch, missing, "--login")

    outcome = await cli_run("shell")

    assert (outcome.status, outcome.out) == (127, b"")
    assert outcome.err == (
        f"{cli.PROG}: cannot start {missing}: No such file or directory - it is the shell command of "
        f"the lab's terminals, which `{cli.PROG} status --json` shows as shell\n")


async def test_acc_cli_144_shell_starts_nothing_when_the_server_reports_no_shell_command(cli_run, monkeypatch):
    """ACC-CLI-144 against a server whose `GET status` has no `shell`, as a server of an earlier version that still runs, `shell` exits 1 with one line that says to restart JupyterLab, and starts nothing."""
    def earlier(handler):
        handler.finish(json.dumps({"version": "0.6.23", **handler.manager.status()}))

    monkeypatch.setattr(StatusHandler, "get", earlier)

    outcome = await cli_run("shell")

    assert (outcome.status, outcome.out) == (1, b"")
    assert outcome.err == (
        f"{cli.PROG}: the server (device bridge 0.6.23) does not report the shell command of its "
        "terminals - restart JupyterLab, so that the server runs the version of this command\n")


def test_acc_cli_146_the_top_level_help_has_a_line_for_shell():
    """ACC-CLI-146 the list of commands in `jupyterlab-device --help` has a line for `shell` that says that it starts a device shell."""
    lines = [line for line in PARSERS[()].format_help().splitlines() if line.startswith("    shell ")]

    assert len(lines) == 1 and "start a device shell" in lines[0]


def test_acc_cli_146_shell_help_says_which_shell_it_starts_that_it_is_a_run_and_when_the_banner_prints():
    """ACC-CLI-146 `shell --help` says that it starts the shell command of the lab's terminals and does not read SHELL, that the Devices panel lists it as a run that the user can stop there, and that the banner prints when standard output is a terminal; its example is the bare command."""
    parser = PARSERS[("shell",)]
    text = " ".join(parser.format_help().split())  # the help text breaks its lines

    assert "Starts the shell command of the lab's terminals" in text
    assert "The variable SHELL is not read" in text
    assert f"the Devices panel of the lab {VIEW_ITEM} lists it as a run" in text
    assert "the user can stop it there" in text
    assert "When standard output is a terminal the command first prints a banner" in text
    assert examples(parser) == [["shell"]]


def test_acc_cli_146_no_help_text_holds_the_line_that_started_a_shell_through_run():
    """ACC-CLI-146 no help text of the command holds `run -- "$SHELL"`, nor the variable in that form at all."""
    for words, parser in PARSERS.items():
        text = parser.format_help()
        assert "$SHELL" not in text and 'run -- "' not in text, " ".join(words)


# ------------------------------------------------------------ the devices in the banner

SERIAL_KEYS = [f"s:2341:0043:{n}" for n in range(4)]
SERIAL_NAMES = [SERIAL_NAME, *(f"{SERIAL_NAME}-{n}" for n in (2, 3, 4))]
SECOND_USB_KEY, SECOND_USB_NAME = "u:cafe:4001:SN0002", f"{USB_NAME}-2"


@pytest.mark.usefixtures("three_upload_tools")
async def test_acc_shim_139_the_banner_lists_an_attached_serial_port_and_an_attached_usb_device(
        cli_run, fake_tab, screen, lab_shell, monkeypatch):
    """ACC-SHIM-139 with one attached serial port and one attached USB device the banner has, under the name line, the line that names the tools, line (1) with the path of the port and ` (COM)`, and line (2) with the name of the USB device and ` (USB)`; `shell` reads the devices with one call."""
    tab, path = await attach_serial(fake_tab)
    assert (await tab.claim_usb())["ok"]
    await tab.until(lambda: tab.devices["usb"])
    asked = device_calls(monkeypatch)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner(f"(1) {path} (COM)", f"(2) {USB_NAME} (USB)") + "started\n"
    assert len(asked) == 1


@pytest.mark.usefixtures("three_upload_tools")
async def test_acc_shim_139_the_banner_lists_no_detached_device_and_no_device_with_an_error(
        cli_run, fake_tab, screen, lab_shell):
    """ACC-SHIM-139 a detached device and a device whose record has an error get no line: the numbers count the listed devices over both kinds, serial devices first, in the order of the server's table."""
    tab = await fake_tab()
    # The USB devices are claimed first: the banner still lists them after the serial ports.
    assert (await tab.claim_usb())["ok"] and (await tab.claim_usb(SECOND_USB_KEY))["ok"]
    for key in SERIAL_KEYS:
        assert (await tab.claim_serial(key))["ok"]
    await tab.release(USB_NAME)
    await tab.release(SERIAL_NAMES[1])
    await tab.send({"type": "serial-state", "name": SERIAL_NAMES[2], "state": "error", "settings": None,
                    "signals": {}, "error": "Failed to open serial port."})
    await tab.until(lambda: [device["state"] for device in tab.devices["usb"]] == ["detached", "attached"])
    await tab.until(lambda: [(device["state"], device["portState"]) for device in tab.devices["serial"]] == [
        ("attached", "open"), ("detached", "closed"), ("attached", "error"), ("attached", "open")])

    status, displayed, _ = await on_a_terminal(cli_run, screen, "shell")

    assert status == 0
    assert displayed == banner(
        f"(1) {record(tab, SERIAL_NAMES[0])['path']} (COM)",
        f"(2) {record(tab, SERIAL_NAMES[3])['path']} (COM)",
        f"(3) {SECOND_USB_NAME} (USB)") + "started\n"


@pytest.mark.usefixtures("three_upload_tools")
async def test_acc_shim_139_the_banner_says_that_no_device_is_attached(
        cli_run, fake_tab, screen, lab_shell):
    """ACC-SHIM-139 when the server has devices and none of them is attached without an error, the one line under the tools reads `No device is attached.`"""
    tab, _ = await attach_serial(fake_tab)
    assert (await tab.claim_usb())["ok"]
    await tab.close()

    status, displayed, _ = await on_a_terminal(cli_run, screen, "shell")

    assert status == 0
    assert displayed == banner("No device is attached.") + "started\n"


def refused(handler):
    raise tornado.web.HTTPError(500)


def no_table(handler):
    handler.finish(json.dumps({"devices": []}))


@pytest.mark.parametrize("answer", [refused, no_table], ids=["the server answers 500", "the answer is no device table"])
@pytest.mark.usefixtures("three_upload_tools")
async def test_acc_shim_139_the_banner_has_no_device_line_when_the_devices_cannot_be_read(
        answer, cli_run, fake_tab, screen, lab_shell, monkeypatch):
    """ACC-SHIM-139 when `GET devices` fails, or answers something that is no device table, the banner has no device line and no line that says that no device is attached; the shell starts and nothing is printed about the failure."""
    await attach_serial(fake_tab)
    monkeypatch.setattr(DevicesHandler, "get", answer)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner() + "started\n"


@pytest.mark.usefixtures("three_upload_tools")
async def test_acc_shim_139_shell_waits_2_s_for_the_devices_then_starts(
        cli_run, fake_tab, screen, lab_shell, monkeypatch):
    """ACC-SHIM-139 when `GET devices` gives no answer, `shell` waits 2 s for it, then prints the banner without a device line and starts the shell."""
    await attach_serial(fake_tab)
    asked = []
    answer = asyncio.Event()

    async def silent(handler):
        asked.append(time.monotonic())
        await answer.wait()

    monkeypatch.setattr(DevicesHandler, "get", silent)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")
    ended = time.monotonic()
    answer.set()
    await asyncio.sleep(0.1)  # the handler ends within the test

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner() + "started\n"
    # 2 s is the time of this call, 10 s the time of every other call of the CLI.
    assert len(asked) == 1 and 1.8 < ended - asked[0] < 5


@pytest.mark.parametrize("words, streams", [(("run", "--", "{shell}"), ("stdin", "stdout")),
                                            (("shell",), ("stdin", "stderr"))],
                         ids=["run with a tool on a terminal", "shell with a pipe as standard output"])
async def test_acc_shim_139_the_devices_are_read_only_when_the_banner_is_printed(
        words, streams, cli_run, fake_tab, screen, lab_shell, monkeypatch):
    """ACC-SHIM-139 a command that prints no banner makes no call for the devices: `run`, and `shell` whose standard output is no terminal."""
    await attach_serial(fake_tab)
    asked = device_calls(monkeypatch)

    status, _, _ = await on_a_terminal(
        cli_run, screen, *(word.format(shell=lab_shell) for word in words), streams=streams)

    assert status == 0 and asked == []


# What the tool line of the banner is for the upload tools on PATH, in the order they are put there.
TOOL_LINES = {
    ("avrdude", "stm32flash", "esptool"): "For avrdude, stm32flash, esptool.",
    ("esptool", "avrdude"): "For avrdude, esptool.",
    ("esptool",): "For esptool.",
}


@pytest.mark.parametrize("tools, line", TOOL_LINES.items(), ids=map(", ".join, TOOL_LINES))
async def test_acc_shim_142_the_tool_line_of_the_banner_names_the_upload_tools_on_path(
        tools, line, cli_run, screen, upload_tools, lab_shell):
    """ACC-SHIM-142 the tool line of the banner names the known upload tools that PATH holds and no other, in the order avrdude, stm32flash, esptool; the top-level help of the same shell has an example for exactly these tools."""
    upload_tools(*tools)

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner(NO_DEVICE, tools=[line]) + "started\n"
    assert top_help().endswith(EXAMPLES_HEAD + example_lines(tools))


@pytest.mark.parametrize("file", [None, "avrdude"], ids=["an empty PATH folder", "a file avrdude that is no program"])
async def test_acc_shim_142_the_banner_says_to_install_a_tool_when_none_is_on_path(
        file, cli_run, screen, upload_tools, lab_shell):
    """ACC-SHIM-142 with no known upload tool that can be run on PATH the banner has, in place of the tool line, the line that none of the three is on PATH and the line that says to install one; no line starts with `For `, and the top-level help of the same shell says that no upload tool is on PATH."""
    folder = upload_tools()
    if file:
        (folder / file).write_text("no program\n")

    status, displayed, piped = await on_a_terminal(cli_run, screen, "shell")

    assert (status, piped) == (0, (None, b""))
    assert displayed == banner(NO_DEVICE, tools=NO_TOOL) + "started\n"
    assert displayed.split("\n")[4:6] == [
        "No avrdude, stm32flash or esptool on PATH.", "Install one to make use of the device shell."]
    assert not any(row.startswith("For ") for row in displayed.split("\n")) and "shim" not in displayed.lower()
    assert top_help().endswith(NO_UPLOAD_TOOL)


async def test_acc_shim_142_a_file_that_is_no_program_is_not_named_in_the_tool_line(
        cli_run, screen, upload_tools, lab_shell):
    """ACC-SHIM-142 a file on PATH that has the name of a known upload tool and cannot be run is not named in the tool line beside a tool that can be run."""
    folder = upload_tools("esptool")
    (folder / "stm32flash").write_text("no program\n")

    status, displayed, _ = await on_a_terminal(cli_run, screen, "shell")

    assert status == 0
    assert displayed == banner(NO_DEVICE, tools=["For esptool."]) + "started\n"


async def test_acc_panel_140_the_banner_names_a_device_shell_and_does_not_hold_the_word_shim(
        cli_run, screen, lab_shell):
    """ACC-PANEL-140 the name line of the banner is 54 columns wide, starts with the name of the command and ends with `device shell`, and the banner does not hold the word shim."""

    status, displayed, _ = await on_a_terminal(cli_run, screen, "shell")

    name_line = displayed.split("\n")[2]
    assert status == 0
    assert name_line == "◆ jupyterlab-device" + " " * 23 + "device shell" and len(name_line) == 54
    assert "shim" not in displayed.lower()


async def test_acc_cli_141_the_banner_names_the_commands_list_and_help(cli_run, screen, lab_shell):
    """ACC-CLI-141 above its rule the banner has an empty line and two lines that name `jupyterlab-device list` with `all devices` and `jupyterlab-device --help` with `example commands`, the two texts in one column."""

    status, displayed, _ = await on_a_terminal(cli_run, screen, "shell")

    lines = displayed.split("\n")
    rule = lines.index("\u2500" * 54 + "\x1b[0m")
    assert status == 0
    assert lines[rule - 3:rule] == [
        "", "jupyterlab-device list      all devices", "jupyterlab-device --help    example commands"]
    assert lines[rule - 2].index("all devices") == lines[rule - 1].index("example commands")


# -------------------------------------------------- the examples in the top-level help

# The known upload tools in the order of the help. For each: its example line outside a
# device shell, and the path that the README has in that line in place of <path>.
UPLOAD_EXAMPLES = {
    "avrdude": ("avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i",
                "/run/devices/tty-2341-0043"),
    "stm32flash": ("jupyterlab-device run -- stm32flash -b 115200 -w firmware.bin -v -g 0x0 <path>",
                   "/run/devices/tty-0403-6001"),
    "esptool": ("jupyterlab-device run -- esptool --port <path> write-flash 0x0 firmware.bin",
                "/run/devices/tty-10c4-ea60"),
}
EXAMPLES_HEAD = """
examples for the upload tools on PATH; <path> is the path of the serial device,
which `jupyterlab-device list` prints:
"""
NO_UPLOAD_TOOL = "\nNo upload tool is on PATH. Known tools: avrdude, stm32flash, esptool.\n"


def path_with(monkeypatch, folder, *tools):
    """Make PATH one new folder that holds stand-in programs with these names, outside a device shell."""
    folder.mkdir()
    for tool in tools:
        stand_in(folder / tool)
    monkeypatch.setenv("PATH", str(folder))
    monkeypatch.delenv("JUPYTERLAB_DEVICE_SHIM_DIR", raising=False)


def top_help():
    """The top-level help as the command prints it at this moment."""
    return cli.build_parser().format_help()


def example_lines(tools, prefixed=True):
    """The example lines of the help for these tools, in the order of the help."""
    lines = (UPLOAD_EXAMPLES[tool][0] for tool in UPLOAD_EXAMPLES if tool in tools)
    return "".join(f"  {line if prefixed else line.removeprefix('jupyterlab-device run -- ')}\n" for line in lines)


@pytest.mark.parametrize("tools", [("avrdude",), ("esptool", "stm32flash"), ("esptool", "avrdude", "stm32flash")],
                         ids=", ".join)
def test_acc_cli_141_the_top_level_help_ends_with_one_example_for_each_upload_tool_on_path(
        tools, tmp_path, monkeypatch):
    """ACC-CLI-141 the top-level help ends with one example line for each known upload tool that PATH holds, in the order avrdude, stm32flash, esptool, and has no line for a tool that PATH does not hold; one sentence above the lines says what <path> stands for."""
    path_with(monkeypatch, tmp_path / "tools", *tools)

    text = top_help()

    assert text.endswith(EXAMPLES_HEAD + example_lines(tools))
    assert text.count("<path>") == 1 + len(tools) and "No upload tool" not in text


@pytest.mark.parametrize("executable", [None, False], ids=["an empty PATH folder", "a file avrdude that is no program"])
def test_acc_cli_141_the_top_level_help_says_that_no_upload_tool_is_on_path(executable, tmp_path, monkeypatch):
    """ACC-CLI-141 with no known upload tool that can be run on PATH the top-level help ends with the sentence that says so and names the three known tools, and has no example line."""
    path_with(monkeypatch, tmp_path / "tools")
    if executable is False:
        (tmp_path / "tools" / "avrdude").write_text("no program\n")

    text = top_help()

    assert text.endswith(NO_UPLOAD_TOOL)
    assert "<path>" not in text and "examples for the upload tools" not in text


def test_acc_cli_141_inside_a_device_shell_the_examples_have_no_run_prefix(tmp_path, monkeypatch):
    """ACC-CLI-141 inside a device shell, where JUPYTERLAB_DEVICE_SHIM_DIR is set, the stm32flash line and the esptool line have no `jupyterlab-device run -- ` before the tool; outside one they have it, and the avrdude line never has it."""
    path_with(monkeypatch, tmp_path / "tools", *UPLOAD_EXAMPLES)
    outside = top_help()
    monkeypatch.setenv("JUPYTERLAB_DEVICE_SHIM_DIR", "/run/devices/.shim")

    inside = top_help()

    assert outside.endswith(EXAMPLES_HEAD + example_lines(UPLOAD_EXAMPLES))
    assert inside.endswith(EXAMPLES_HEAD + example_lines(UPLOAD_EXAMPLES, prefixed=False))
    assert inside.splitlines()[-3:] == [
        "  avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i",
        "  stm32flash -b 115200 -w firmware.bin -v -g 0x0 <path>",
        "  esptool --port <path> write-flash 0x0 firmware.bin"]
    assert outside.splitlines()[-3:] == [f"  {line}" for line, _ in UPLOAD_EXAMPLES.values()]


def test_acc_cli_141_each_example_of_the_help_is_a_command_line_of_the_readme(tmp_path, monkeypatch):
    """ACC-CLI-141 each example line of the help outside a device shell, with the example path of the README in place of <path>, is a line of a `bash` block of the README section Working with an AI agent."""
    path_with(monkeypatch, tmp_path / "tools", *UPLOAD_EXAMPLES)
    documented = command_lines(readme()["Working with an AI agent"])

    printed = [line.strip() for line in top_help().splitlines() if line.startswith("  ") and "<path>" in line]

    assert len(printed) == 3
    for line, (_, device) in zip(printed, UPLOAD_EXAMPLES.values()):
        assert line.replace("<path>", device) in documented, line


def test_acc_cli_141_the_help_of_the_subcommands_does_not_change(tmp_path, monkeypatch):
    """ACC-CLI-141 the help of every subcommand is the same with all three upload tools on PATH and with none, and holds no example of the top-level help."""
    def subcommands():
        return {words: parser.format_help() for words, parser in parsers(cli.build_parser()) if words}

    path_with(monkeypatch, tmp_path / "tools", *UPLOAD_EXAMPLES)
    with_tools = subcommands()
    path_with(monkeypatch, tmp_path / "none")

    assert subcommands() == with_tools and len(with_tools) == len(SUBCOMMANDS)
    for text in with_tools.values():
        assert "<path>" not in text and "upload tools on PATH;" not in text and "No upload tool" not in text


async def test_acc_cli_141_the_command_prints_the_examples_where_no_server_answers(cli_run, tmp_path, monkeypatch):
    """ACC-CLI-141 the real command ends `--help` with the example of the one upload tool on its PATH, with exit 0 and nothing on stderr, where no server answers and PATH holds no `jupyter` to find one with."""
    cli_run.server_list(None)
    monkeypatch.setenv("JUPYTER_PORT", "9")
    path_with(monkeypatch, tmp_path / "tools", "avrdude")

    outcome = await cli_run("--help")

    assert (outcome.status, outcome.err) == (0, "")
    assert outcome.out.decode().endswith(EXAMPLES_HEAD + example_lines(["avrdude"]))


def test_acc_cli_135_run_help_says_that_the_devices_panel_lists_the_run_and_that_the_user_can_stop_it():
    """ACC-CLI-135 `run --help` states that the Devices panel of the lab lists the run, that the user can stop it there, and which signals the tool then receives."""
    text = " ".join(PARSERS[("run",)].format_help().split())  # the help text breaks its lines

    assert f"the Devices panel of the lab {VIEW_ITEM} lists the run" in text
    assert "the user can stop it there" in text
    assert f"receives SIGTERM, and SIGKILL {manager_module.RUN_KILL_S:g} s later when it still runs" in text


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
