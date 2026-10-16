"""Tests of the environment selector of the device shell: the lookup in `environments.py`,
the Textual list in `env_picker.py`, and `jupyterlab-device shell` with both.

The conda command is a script of the test, named by CONDA_EXE, so the environments of the
machine that runs the tests do not reach them. The shell runs on a pty of the test.
"""

import asyncio
import fcntl
import json
import os
import struct
import sys
import termios
import time

import pytest
from textual.widgets import OptionList

from jupyterlab_device_bridge_extension import cli, environments, tui_theme
from jupyterlab_device_bridge_extension.env_picker import EnvironmentPicker
from jupyterlab_device_bridge_extension.environments import Environment

from .test_cli import (  # noqa: F401 - `cli_run`, `lab`, `lab_shell` and `screen` are fixtures
    BANNER_BOTTOM, BANNER_TOP, NO_DEVICE, cli_run, lab, lab_shell, on_a_terminal, screen, stand_in, terminal_shell)

NAMES = list(cli._TOOL_NAMES)
QUESTION = "Start the device shell in which environment?"
DARK, LIGHT = tui_theme.THEMES["dark"].name, tui_theme.THEMES["light"].name


def programs(folder, *names):
    """Make a folder with stand-in programs of these names; returns the folder."""
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        stand_in(folder / name)
    return folder


def conda_env(root, name, *tools):
    """A conda environment directory whose bin holds stand-ins of these tools; returns its prefix."""
    prefix = root / name
    programs(prefix / "bin", "python", *tools)
    return str(prefix)


def fake_conda(path, envs, variables=None, body=None):
    """Write a conda command that lists `envs` and gives `variables` to `env config vars list -p <prefix>`.

    Args:
        envs: The prefixes that `conda env list --json` prints.
        variables: `{prefix: {name: value}}`.
        body: Shell lines that replace the whole command, for a conda that fails.
    """
    listed = {"envs": envs, "envs_details": {prefix: {"name": os.path.basename(prefix)} for prefix in envs}}
    path.write_text(body if body is not None else (
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"listed, variables = {json.dumps(listed)!r}, {json.dumps(variables or {})!r}\n"
        "words = sys.argv[1:]\n"
        "if words[:3] == ['env', 'list', '--json']:\n"
        "    print(listed)\n"
        "elif words[:5] == ['env', 'config', 'vars', 'list', '-p']:\n"
        "    print(json.dumps(json.loads(variables).get(words[5], {})))\n"
        "else:\n"
        "    sys.exit(2)\n"))
    path.chmod(0o755)
    return str(path)


@pytest.fixture(autouse=True)
def no_active_environment(monkeypatch):
    """No environment is active and no theme question reaches a terminal of the machine."""
    for name in ("CONDA_PREFIX", "CONDA_DEFAULT_ENV", "VIRTUAL_ENV", "RUSTUP_HOME", "NO_COLOR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TEXTUAL_THEME", DARK)


@pytest.fixture
def project(tmp_path, monkeypatch):
    """The start directory of the shell and the working directory of the test, which holds no `.venv` until a test makes one."""
    folder = tmp_path / "project"
    folder.mkdir()
    monkeypatch.chdir(folder)
    return folder


# ------------------------------------------------------------------------- the lookup


def test_acc_shim_176_the_lookup_finds_the_environments_that_hold_an_upload_tool(tmp_path, project, monkeypatch):
    """ACC-SHIM-176 of a conda environment with bin/esptool, one without a tool and a `.venv` with bin/avrdude in the start directory, the lookup finds the two with tools, each with its tools, the project first."""
    with_tool = conda_env(tmp_path / "envs", "with-tool", "esptool")
    without = conda_env(tmp_path / "envs", "without-tool")
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [with_tool, without]))
    programs(project / ".venv" / "bin", "python", "avrdude")

    found = environments.find(str(project), NAMES)

    assert found == [
        Environment(".venv", "project", ("avrdude",), str(project / ".venv")),
        Environment("with-tool", "global", ("esptool",), with_tool, conda=True)]


def test_acc_shim_176_the_active_environment_is_not_offered(tmp_path, project, monkeypatch):
    """ACC-SHIM-176 the conda environment that CONDA_PREFIX names and the `.venv` that VIRTUAL_ENV names are the current environment and are not offered."""
    active = conda_env(tmp_path / "envs", "active", "esptool")
    other = conda_env(tmp_path / "envs", "other", "stm32flash")
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [active, other]))
    programs(project / ".venv" / "bin", "avrdude")
    monkeypatch.setenv("CONDA_PREFIX", active)
    monkeypatch.setenv("VIRTUAL_ENV", str(project / ".venv"))

    assert environments.find(str(project), NAMES) == [
        Environment("other", "global", ("stm32flash",), other, conda=True)]


def test_acc_shim_176_conda_is_found_on_path_without_conda_exe(tmp_path, project, monkeypatch):
    """ACC-SHIM-176 without CONDA_EXE the lookup runs the conda of PATH."""
    prefix = conda_env(tmp_path / "envs", "on-path", "avrdude")
    folder = programs(tmp_path / "path")
    fake_conda(folder / "conda", [prefix])
    monkeypatch.delenv("CONDA_EXE", raising=False)
    monkeypatch.setenv("PATH", str(folder))

    assert environments.find(str(project), NAMES) == [
        Environment("on-path", "global", ("avrdude",), prefix, conda=True)]


def test_acc_shim_182_the_lookup_offers_an_environment_that_holds_only_pio(tmp_path, project, monkeypatch):
    """ACC-SHIM-182 pio is a known upload tool: the lookup offers a conda environment whose bin holds pio and no other tool, and lists pio after the other tools."""
    assert NAMES == ["avrdude", "stm32flash", "esptool", "pio"]
    only_pio = conda_env(tmp_path / "envs", "only-pio", "pio")
    both = conda_env(tmp_path / "envs", "both", "pio", "avrdude")
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [only_pio, both]))

    assert environments.find(str(project), NAMES) == [
        Environment("only-pio", "global", ("pio",), only_pio, conda=True),
        Environment("both", "global", ("avrdude", "pio"), both, conda=True)]


def test_acc_shim_182_upload_tools_holds_the_pio_line_that_needs_the_shim():
    """ACC-SHIM-182 the known upload tools end with pio, its line `pio run -t upload --upload-port <path>`, marked as needing the shim."""
    assert cli.UPLOAD_TOOLS[-1] == ("pio", "pio run -t upload --upload-port <path>", True)


# A conda command for each way it can fail, as shell lines. sleep is named by its full path:
# the PATH of the CLI in the shell tests holds no sleep.
FAILING_CONDA = {
    "exits 1": "#!/bin/sh\necho '{\"envs\": []}'\nexit 1\n",
    "prints no JSON": "#!/bin/sh\necho 'conda: no environments here'\n",
    "prints JSON that is no list of environments": "#!/bin/sh\necho '{\"envs\": 7}'\n",
    "sleeps 10 s": "#!/bin/sh\nexec /bin/sleep 10\n",
}


@pytest.mark.parametrize("body", FAILING_CONDA.values(), ids=FAILING_CONDA)
def test_acc_shim_181_a_failing_conda_skips_only_the_conda_environments(body, tmp_path, project, monkeypatch):
    """ACC-SHIM-181 a conda that exits 1, prints no JSON, prints a document of another form or runs 10 s gives no conda environment, the `.venv` is still found, and the lookup ends within 5 s of its limit."""
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [], body=body))
    programs(project / ".venv" / "bin", "avrdude")

    started = time.monotonic()
    found = environments.find(str(project), NAMES)

    assert time.monotonic() - started < environments.LOOKUP_S + 1
    assert found == [Environment(".venv", "project", ("avrdude",), str(project / ".venv"))]


def test_acc_shim_181_without_conda_pipx_and_uv_the_lookup_finds_the_venv_and_the_tools_of_path(
        tmp_path, project, monkeypatch):
    """ACC-SHIM-181 with no conda at CONDA_EXE, none on PATH and none at the default place, and no pipx and no uv, the lookup runs no command for them: it finds the `.venv` and the tools of PATH."""
    monkeypatch.delenv("CONDA_EXE", raising=False)
    monkeypatch.setattr(environments, "DEFAULT_CONDA", str(tmp_path / "no-conda"))
    monkeypatch.setenv("PATH", str(programs(tmp_path / "path", "esptool")))
    programs(project / ".venv" / "bin", "avrdude")

    assert environments.find(str(project), NAMES) == [
        Environment(".venv", "project", ("avrdude",), str(project / ".venv"))]
    assert environments.current(NAMES) == Environment("current environment", "current", ("esptool",))


def test_acc_shim_181_a_lookup_command_that_exits_non_zero_adds_nothing_that_it_printed(
        tmp_path, project, monkeypatch):
    """ACC-SHIM-181 a conda that lists an environment with bin/esptool and a pipx that prints a folder with stm32flash both exit 1: the lookup offers no conda environment and the current environment has no stm32flash."""
    listing = json.dumps({"envs": [conda_env(tmp_path / "envs", "listed", "esptool")]})
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [], body=f"#!/bin/sh\necho '{listing}'\nexit 1\n"))
    folder = programs(tmp_path / "path")
    (folder / "pipx").write_text(f"#!/bin/sh\necho '{programs(tmp_path / 'pipx-bin', 'stm32flash')}'\nexit 1\n")
    (folder / "pipx").chmod(0o755)
    monkeypatch.setenv("PATH", str(folder))

    assert environments.find(str(project), NAMES) == []
    assert environments.current(NAMES).tools == ()


def test_acc_shim_180_the_current_environment_has_the_tools_of_path_pipx_and_uv(tmp_path, monkeypatch):
    """ACC-SHIM-180 the current environment lists the upload tools of PATH and of the bin directories that `pipx environment` and `uv tool dir --bin` print, in the order of the known tools; a pipx that fails adds nothing."""
    pipx_bin = programs(tmp_path / "pipx-bin", "stm32flash")
    uv_bin = programs(tmp_path / "uv-bin", "pio")
    folder = programs(tmp_path / "path", "esptool")
    (folder / "pipx").write_text(f"#!/bin/sh\n[ \"$*\" = 'environment --value PIPX_BIN_DIR' ] && echo '{pipx_bin}'\n")
    (folder / "uv").write_text(f"#!/bin/sh\n[ \"$*\" = 'tool dir --bin' ] && echo '{uv_bin}'\n")
    (folder / "pipx").chmod(0o755)
    (folder / "uv").chmod(0o755)
    monkeypatch.setenv("PATH", str(folder))

    assert environments.current(NAMES).tools == ("stm32flash", "esptool", "pio")

    (folder / "pipx").write_text("#!/bin/sh\nexit 1\n")
    assert environments.current(NAMES).tools == ("esptool", "pio")


def test_acc_shim_178_the_activation_of_a_conda_environment_and_of_a_venv(tmp_path, monkeypatch):
    """ACC-SHIM-178 a conda environment puts its bin first on PATH and sets CONDA_PREFIX, CONDA_DEFAULT_ENV and its own variables; a `.venv` puts its bin first and sets VIRTUAL_ENV; the current environment changes nothing."""
    prefix = conda_env(tmp_path / "envs", "firmware-esp", "esptool")
    variables = {prefix: {"RUSTUP_HOME": f"{prefix}/rustup"}}
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [prefix], variables))
    venv = str(tmp_path / ".venv")

    conda = environments.activation(Environment("firmware-esp", "global", ("esptool",), prefix, True), "/usr/bin:/bin")
    project = environments.activation(Environment(".venv", "project", ("avrdude",), venv), "/usr/bin")

    assert conda == {"PATH": f"{prefix}/bin:/usr/bin:/bin", "CONDA_PREFIX": prefix,
                     "CONDA_DEFAULT_ENV": "firmware-esp", "RUSTUP_HOME": f"{prefix}/rustup"}
    assert project == {"PATH": f"{venv}/bin:/usr/bin", "VIRTUAL_ENV": venv}
    assert environments.activation(Environment("current environment", "current", ()), "/usr/bin") == {}


# ----------------------------------------------------------------------- the selector

CURRENT = Environment("current environment", "current", ("esptool",))
FIRST = Environment("firmware-avr", "global", ("avrdude", "pio"), "/envs/firmware-avr", True)
SECOND = Environment(".venv", "project", ("stm32flash",), "/work/.venv")


def entries(app):
    """The lines of the list of the selector."""
    options = app.query_one(OptionList)
    return [str(options.get_option_at_index(index).prompt) for index in range(options.option_count)]


async def test_acc_shim_177_two_environments_give_three_entries_and_down_enter_chooses_the_first_found():
    """ACC-SHIM-177 with two environments found the list has three entries: the current environment first, then each found one with its name, project or global, and its tools; Down then Enter returns the first found."""
    app = EnvironmentPicker(CURRENT, [FIRST, SECOND], DARK)

    async with app.run_test(size=(80, 24)) as pilot:
        assert entries(app) == [
            "current environment           esptool",
            "firmware-avr         global   avrdude, pio",
            ".venv                project  stm32flash"]
        await pilot.press("down", "enter")

    assert app.return_value == FIRST


@pytest.mark.parametrize("keys", [("escape",), ("down", "escape"), ("enter",), ("ctrl+c",)], ids=" ".join)
async def test_acc_shim_177_esc_keeps_the_current_environment(keys):
    """ACC-SHIM-177 Esc returns the current environment, also after the highlight moved; Enter on the first entry and Ctrl+C return it too."""
    app = EnvironmentPicker(CURRENT, [FIRST, SECOND], DARK)

    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.press(*keys)

    assert app.return_value == CURRENT


@pytest.mark.parametrize("mode", ["dark", "light"])
async def test_acc_shim_177_the_selector_has_the_brand_themes_dark_and_light(mode):
    """ACC-SHIM-177 the selector runs in the brand theme it is given, dark and light, and its screen has the screen colour of that theme."""
    app = EnvironmentPicker(CURRENT, [FIRST], tui_theme.THEMES[mode].name)

    async with app.run_test(size=(80, 24)):
        assert app.theme == f"stellars-tech-{mode}"
        assert app.screen.styles.background.hex.lower() == tui_theme.PALETTES[mode]["screen"]
        assert app.query_one(OptionList).styles.background.hex.lower() == tui_theme.PALETTES[mode]["screen"]


# ------------------------------------------------------------------ the device shell

# A shell command for the terminals of the test server: prints the first folder of PATH and
# the variables an activation sets, then ends. Only what `sh` has built in.
REPORTING_SHELL = """#!/bin/sh
echo "first ${PATH%%:*}"
echo "CONDA_PREFIX ${CONDA_PREFIX:-}"
echo "CONDA_DEFAULT_ENV ${CONDA_DEFAULT_ENV:-}"
echo "RUSTUP_HOME ${RUSTUP_HOME:-}"
echo "VIRTUAL_ENV ${VIRTUAL_ENV:-}"
"""
# The escape sequence with which Textual takes the alternate screen of a terminal.
ALTERNATE_SCREEN = "\x1b[?1049h"


def banner(*lines):
    """What a terminal shows for the banner of a device shell with these lines under its name line."""
    body = "".join(f"{line}\n" for line in lines)
    return f"\x1b[38;2;159;224;238m{BANNER_TOP}{body}{BANNER_BOTTOM}\x1b[0m\n\n"


@pytest.fixture
def shell_path(cli_run, tmp_path, monkeypatch):
    """PATH of the CLI: the private `jupyter` and a folder of stand-in tools, nothing of the machine.

    Returns:
        The call that adds stand-ins to that folder.
    """
    from jupyterlab_device_bridge_extension import shim_build
    shim_build.build()  # with the PATH of the test run, which has the C compiler
    folder = programs(tmp_path / "tools")
    monkeypatch.setenv("PATH", os.pathsep.join([str(folder), str(cli_run.binaries)]))
    monkeypatch.setattr(environments, "DEFAULT_CONDA", str(tmp_path / "no-conda"))
    monkeypatch.setenv("CONDA_EXE", str(tmp_path / "no-conda"))
    return lambda *names: programs(folder, *names)


def sized(screen):
    """Give the terminal of a `Screen` 24 rows of 100 columns, which Textual needs to draw."""
    fcntl.ioctl(screen.terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    return screen


async def reading(screen, seconds):
    """Read what the terminal displays for this time."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        screen.displayed()
        await asyncio.sleep(0.01)


async def until_displayed(screen, text, timeout=20):
    """Wait until the terminal displayed this text."""
    deadline = time.monotonic() + timeout
    while text not in screen.displayed():
        assert time.monotonic() < deadline, f"the terminal did not display {text!r}"
        await asyncio.sleep(0.05)


async def shell_with_keys(cli_run, screen, *keys):
    """Run `shell` on all three streams of the terminal, answer the selector with these keys, and wait for the end.

    Returns:
        The exit status and what the terminal displayed.
    """
    sized(screen)
    try:
        child = await cli_run.start("shell", stdin=screen.terminal, stdout=screen.terminal, stderr=screen.terminal)
    finally:
        os.close(screen.terminal)
    await until_displayed(screen, QUESTION)
    for key in keys:
        os.write(screen.keyboard, key)
        await reading(screen, 0.3)
    # The terminal is read while the child runs: a child whose output fills the terminal
    # stops in its write until that output is read.
    deadline = time.monotonic() + 30
    while child.returncode is None or not screen.closed:
        assert time.monotonic() < deadline, "a process still has the terminal open"
        await reading(screen, 0.01)
    return child.returncode, screen.displayed()


DOWN, ENTER, ESC = b"\x1b[B", b"\r", b"\x1b"
NO_TOOL = ("No avrdude, stm32flash, esptool or pio on PATH.", "Install one to make use of the device shell.")


@pytest.mark.usefixtures("shell_path")
async def test_acc_shim_178_the_shell_runs_in_the_chosen_conda_environment(
        cli_run, screen, project, jp_serverapp, tmp_path, monkeypatch):
    """ACC-SHIM-178 Down and Enter in the selector of `shell` choose the conda environment with bin/esptool and the variable RUSTUP_HOME: the shell starts with its bin first on PATH, CONDA_PREFIX, CONDA_DEFAULT_ENV and RUSTUP_HOME, and the banner names the environment and lists its tools."""
    prefix = conda_env(tmp_path / "envs", "fake-esp", "esptool")
    variables = {prefix: {"RUSTUP_HOME": f"{prefix}/rustup"}}
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [prefix], variables))
    launcher = tmp_path / "reporting-shell"
    launcher.write_text(REPORTING_SHELL)
    launcher.chmod(0o755)
    terminal_shell(jp_serverapp, monkeypatch, str(launcher))

    status, after = await shell_with_keys(cli_run, screen, DOWN, ENTER)

    assert status == 0
    assert after.endswith(banner("Environment: fake-esp (global)", "For esptool.", NO_DEVICE) + (
        f"first {prefix}/bin\nCONDA_PREFIX {prefix}\nCONDA_DEFAULT_ENV fake-esp\n"
        f"RUSTUP_HOME {prefix}/rustup\nVIRTUAL_ENV \n"))


@pytest.mark.usefixtures("shell_path")
async def test_acc_shim_178_the_shell_runs_in_the_chosen_project_venv(
        cli_run, screen, project, jp_serverapp, tmp_path, monkeypatch):
    """ACC-SHIM-178 Down and Enter choose the `.venv` of the start directory: the shell starts with its bin first on PATH and VIRTUAL_ENV, and the banner names it as the project environment with its tools."""
    programs(project / ".venv" / "bin", "avrdude")
    launcher = tmp_path / "reporting-shell"
    launcher.write_text(REPORTING_SHELL)
    launcher.chmod(0o755)
    terminal_shell(jp_serverapp, monkeypatch, str(launcher))
    venv = project / ".venv"

    status, after = await shell_with_keys(cli_run, screen, DOWN, ENTER)

    assert status == 0
    assert after.endswith(banner("Environment: .venv (project)", "For avrdude.", NO_DEVICE) + (
        f"first {venv}/bin\nCONDA_PREFIX \nCONDA_DEFAULT_ENV \nRUSTUP_HOME \nVIRTUAL_ENV {venv}\n"))


async def test_acc_shim_177_esc_in_the_selector_of_shell_keeps_the_current_environment(
        cli_run, screen, project, lab_shell, shell_path):
    """ACC-SHIM-177 Esc in the selector of `shell` starts the shell in the current environment: the banner has no line of an environment and lists the tools of PATH."""
    shell_path("esptool")
    programs(project / ".venv" / "bin", "avrdude")

    status, after = await shell_with_keys(cli_run, screen, ESC)

    assert status == 0
    assert after.endswith(banner("For esptool.", NO_DEVICE) + "started\n")


async def test_acc_shim_179_no_selector_when_no_environment_holds_a_tool(
        cli_run, screen, project, lab_shell, shell_path, tmp_path, monkeypatch):
    """ACC-SHIM-179 when no environment other than the current one holds an upload tool, `shell` on a terminal shows no selector and starts the shell at once."""
    without = conda_env(tmp_path / "envs", "without-tool")
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [without]))
    programs(project / ".venv" / "bin", "python")

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell",
                                               streams=("stdin", "stdout", "stderr"))

    assert status == 0
    assert displayed == banner(*NO_TOOL, NO_DEVICE) + "started\n"
    assert ALTERNATE_SCREEN not in displayed


async def test_acc_shim_179_no_selector_when_standard_input_is_no_terminal(
        cli_run, screen, project, lab_shell, shell_path):
    """ACC-SHIM-179 with standard input a pipe `shell` shows no selector although `.venv` holds a tool, and starts the shell in the current environment."""
    programs(project / ".venv" / "bin", "avrdude")

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell",
                                               streams=("stdout", "stderr"))

    assert status == 0
    assert displayed == banner(*NO_TOOL, NO_DEVICE) + "started\n"
    assert ALTERNATE_SCREEN not in displayed


async def test_acc_shim_179_run_never_shows_the_selector(cli_run, screen, project, lab_shell, shell_path):
    """ACC-SHIM-179 `run -- <tool>` on a terminal shows no selector although `.venv` holds a tool."""
    programs(project / ".venv" / "bin", "avrdude")

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "run", "--", lab_shell,
                                               streams=("stdin", "stdout", "stderr"))

    assert (status, displayed) == (0, "started\n")


async def test_acc_shim_180_without_any_environment_the_shell_starts_at_once_with_the_tools_of_path(
        cli_run, screen, project, lab_shell, shell_path):
    """ACC-SHIM-180 with no conda, no `.venv` and esptool on PATH, `shell` on a terminal shows no selector and its banner lists esptool, as before environments were looked up."""
    shell_path("esptool")

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell",
                                               streams=("stdin", "stdout", "stderr"))

    assert status == 0
    assert displayed == banner("For esptool.", NO_DEVICE) + "started\n"


async def test_acc_shim_180_the_banner_lists_the_tools_of_the_pipx_and_uv_tool_directories(
        cli_run, screen, project, lab_shell, shell_path, tmp_path):
    """ACC-SHIM-180 the tool line of the banner of the current environment lists the upload tools of the pipx and uv tool directories, which are not on PATH."""
    pipx_bin = programs(tmp_path / "pipx-bin", "avrdude")
    uv_bin = programs(tmp_path / "uv-bin", "esptool")
    folder = shell_path()
    (folder / "pipx").write_text(f"#!/bin/sh\necho '{pipx_bin}'\n")
    (folder / "uv").write_text(f"#!/bin/sh\necho '{uv_bin}'\n")
    (folder / "pipx").chmod(0o755)
    (folder / "uv").chmod(0o755)

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell",
                                               streams=("stdin", "stdout", "stderr"))

    assert status == 0
    assert displayed == banner("For avrdude, esptool.", NO_DEVICE) + "started\n"


@pytest.mark.parametrize("body", FAILING_CONDA.values(), ids=FAILING_CONDA)
async def test_acc_shim_181_the_shell_starts_when_conda_fails(
        body, cli_run, screen, project, lab_shell, shell_path, tmp_path, monkeypatch):
    """ACC-SHIM-181 with a conda that exits 1, prints no JSON, prints a document of another form or runs 10 s, and failing pipx and uv, `shell` on a terminal starts the shell, prints no traceback and shows no selector."""
    monkeypatch.setenv("CONDA_EXE", fake_conda(tmp_path / "conda", [], body=body))
    folder = shell_path("esptool")
    for name in ("pipx", "uv"):
        (folder / name).write_text("#!/bin/sh\necho 'not a folder' >&2\nexit 3\n")
        (folder / name).chmod(0o755)

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell",
                                               streams=("stdin", "stdout", "stderr"))

    assert status == 0
    assert displayed == banner("For esptool.", NO_DEVICE) + "started\n"
    assert "Traceback" not in displayed


async def test_acc_shim_182_the_banner_lists_pio(cli_run, screen, project, lab_shell, shell_path):
    """ACC-SHIM-182 with pio and avrdude on PATH the tool line of the banner names both, pio last; with no tool the banner names pio among the known tools."""
    shell_path("pio", "avrdude")

    status, displayed, _ = await on_a_terminal(cli_run, sized(screen), "shell")

    assert status == 0
    assert displayed == banner("For avrdude, pio.", NO_DEVICE) + "started\n"
    assert cli._tool_lines([]) == list(NO_TOOL)
