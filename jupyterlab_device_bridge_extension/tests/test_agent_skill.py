"""The agent skill of the `jupyterlab-device` CLI: where it is, what it names, and that the wheel installs it.

The skill ships twice: the repository copy an agent reads from a clone, and the copy
the wheel's shared-data mapping puts under `sys.prefix`. Two copies drift, so they are
compared byte for byte here. The same holds for the firmware installers of
`resources/envs`, which the wheel puts in `envs/` beside the installed skill.
"""

import os
import pathlib
import re
import sys
import tomllib

import pytest

from .test_cli import PARSERS

SKILL_NAME = "jupyterlab-device-bridge-extension"
REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
REPOSITORY_COPY = REPOSITORY / ".agents" / "skills" / SKILL_NAME / "SKILL.md"
INSTALLED_COPY = pathlib.Path(sys.prefix) / "share" / "jupyter" / "agents" / "skills" / SKILL_NAME / "SKILL.md"
ENVS = REPOSITORY / "resources" / "envs"
INSTALLED_ENVS = INSTALLED_COPY.parent / "envs"
INSTALLERS = ("firmware-avr.py", "firmware-stm32.py", "firmware-esp.py")

pytestmark = pytest.mark.skipif(
    not REPOSITORY_COPY.is_file(),
    reason="no repository copy to compare against outside a source checkout",
)


def test_acc_cli_86_the_skill_is_in_the_repository_and_mapped_into_the_wheel():
    """ACC-CLI-86 the skill is named after the extension, points at `--help`, and pyproject.toml maps its directory into the wheel."""
    skill = REPOSITORY_COPY.read_text()
    shared = tomllib.loads((REPOSITORY / "pyproject.toml").read_text())[
        "tool"]["hatch"]["build"]["targets"]["wheel"]["shared-data"]

    assert shared[f".agents/skills/{SKILL_NAME}"] == f"share/jupyter/agents/skills/{SKILL_NAME}"
    assert re.search(rf"^name: {SKILL_NAME}$", skill, re.MULTILINE)
    assert "`jupyterlab-device --help`" in skill and "`jupyterlab-device <command> --help`" in skill
    assert len(skill.splitlines()) < 30, "the detail lives in --help, not in the skill"


def test_acc_cli_86_the_skill_names_only_commands_and_flags_that_exist():
    """ACC-CLI-86 every flag and every command the skill names in backticks is one the CLI has."""
    rules = REPOSITORY_COPY.read_text().split("## Rules", 1)[1]
    flags = {flag for parser in PARSERS.values() for action in parser._actions for flag in action.option_strings}
    commands = {" ".join(path) for path in PARSERS if path}
    code = re.findall(r"`([^`]+)`", rules)

    assert set(re.findall(r"--[a-z][a-z-]*", rules)) <= flags
    named = {span for span in code if span.split()[0] in {path[0] for path in PARSERS if path}}
    assert named, "the rules name commands"
    for span in named:
        words = [word for word in span.split() if not word.startswith("-")]
        assert " ".join(words) in commands, f"`{span}` is not a command of the CLI"


def test_acc_cli_124_the_skill_names_the_view_menu_item_where_it_sends_the_user_to_the_devices_panel():
    """ACC-CLI-124 every rule of the skill that sends the user to the Devices panel names the View menu item Show Devices Panel, once, in ASCII."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    lines = [line for line in skill.splitlines() if "Devices panel" in line]

    assert lines, "a rule of the skill sends the user to the Devices panel"
    for line in lines:
        assert line.count("(if no sidebar has the panel: menu View, item Show Devices Panel)") == 1, line
    assert skill.isascii()


def test_acc_cli_86_the_installed_skill_is_the_repository_copy():
    """ACC-CLI-86 the wheel installs a copy of the skill that is identical to the repository's."""
    assert INSTALLED_COPY.is_file(), (
        f"{INSTALLED_COPY} is missing: the package in this environment was installed before "
        "pyproject.toml mapped the skill into the wheel - run make install")
    assert INSTALLED_COPY.read_bytes() == REPOSITORY_COPY.read_bytes(), (
        "the installed agent skill differs from the repository copy - run make install")


def test_acc_cli_126_one_rule_of_the_skill_names_the_firmware_installers_and_asks_the_user_first():
    """ACC-CLI-126 one rule of the skill names the three installers and both folders, and tells the agent to ask the user before running one."""
    rules = REPOSITORY_COPY.read_text().split("## Rules", 1)[1]
    lines = [line for line in rules.splitlines() if "firmware-" in line]

    assert len(lines) == 1, f"{len(lines)} rules of the skill name a firmware installer"
    (rule,) = lines
    for name in INSTALLERS:
        assert f"`{name}`" in rule and (ENVS / name).is_file(), name
    assert "`envs/` beside this file" in rule and "`resources/envs/`" in rule
    assert "Ask user before running one" in rule


def test_acc_cli_135_one_rule_of_the_skill_says_that_the_devices_panel_lists_a_run_and_that_the_user_can_stop_it():
    """ACC-CLI-135 one rule of the skill states that the Devices panel of the lab lists a tool started under `run --` and that the user can stop it there."""
    rules = REPOSITORY_COPY.read_text().split("## Rules", 1)[1]
    lines = [line for line in rules.splitlines() if "user can stop it there" in line]

    assert len(lines) == 1, f"{len(lines)} rules of the skill say that the user can stop a run"
    (rule,) = lines
    assert "under `run --`" in rule
    assert "Devices panel of the lab (if no sidebar has the panel: menu View, item Show Devices Panel) lists it" in rule


def test_acc_cli_146_the_skill_has_one_rule_for_shell_and_does_not_hold_the_old_line():
    """ACC-CLI-146 the skill does not hold `run -- "$SHELL"` nor the variable in that form, and one rule says that `shell` is a device shell for a person and that an agent starts each tool under `run --`."""
    skill = REPOSITORY_COPY.read_text()
    lines = [line for line in skill.split("## Rules", 1)[1].splitlines() if "`shell`" in line]

    assert "$SHELL" not in skill and 'run -- "' not in skill
    assert len(lines) == 1, f"{len(lines)} rules of the skill name the command shell"
    (rule,) = lines
    assert "device shell for a person at a terminal" in rule
    assert "Agent starts each tool under `run --`" in rule


def test_acc_cli_126_the_wheel_installs_the_firmware_installers_beside_the_skill():
    """ACC-CLI-126 pyproject.toml maps resources/envs into the folder of the installed skill, and the installed files are the repository's, the installers executable."""
    shared = tomllib.loads((REPOSITORY / "pyproject.toml").read_text())[
        "tool"]["hatch"]["build"]["targets"]["wheel"]["shared-data"]
    names = sorted(path.name for path in ENVS.iterdir() if path.is_file())

    assert shared.get("resources/envs") == f"share/jupyter/agents/skills/{SKILL_NAME}/envs"
    assert names == sorted([*INSTALLERS, "firmware_env.py"])
    for name in names:
        assert (INSTALLED_ENVS / name).is_file(), (
            f"{INSTALLED_ENVS / name} is missing: the package in this environment was installed "
            "before pyproject.toml mapped resources/envs into the wheel - run make install")
        assert (INSTALLED_ENVS / name).read_bytes() == (ENVS / name).read_bytes(), (
            f"the installed {name} differs from the repository copy - run make install")
    for name in INSTALLERS:
        assert os.access(INSTALLED_ENVS / name, os.X_OK), f"the installed {name} is not executable"
