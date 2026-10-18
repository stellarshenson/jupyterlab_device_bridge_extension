"""The README against the brief: the agent section, the driver table, the limits, the shim and the backend.

The tests read `README.md` of the repository. A wheel carries this file without a
README beside the package, so outside a source checkout the tests are skipped.
"""

import itertools
import pathlib
import re
import shlex

import pytest

from jupyterlab_device_bridge_extension import cli, pyusb_backend, shim_build

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
SKILL = REPOSITORY / ".agents" / "skills" / "jupyterlab-device-bridge-extension" / "SKILL.md"

pytestmark = pytest.mark.skipif(
    not (REPOSITORY / "pyproject.toml").is_file(),
    reason="no README to read outside a source checkout",
)

FENCE = re.compile(r"^```(\w*)\n(.*?)^```$", re.MULTILINE | re.DOTALL)
PROGRAM = f"{cli.PROG} "

# Board family, as its subsection of "Working with an AI agent" names it, and what the
# command lines of that subsection must hold: the upload tools and the saved configs.
FAMILIES = {
    "AVR": ("avrdude", "Arduino upload", "Arduino as ISP"),
    "STM32": ("stm32flash", "pyocd", "STM32 bootloader"),
    "ESP": ("esptool", "ESP upload", "--before no-reset", f"{PROGRAM}run --device tty-10c4-ea60 -- esptool"),
}
# One phrase of each item of docs/brief.md, "Not in the first version".
LIMITS = ("libusb", "WebHID", "USB/IP", "inside the browser", "Isochronous", "probe-rs")


def sections(text: str, level: int = 2) -> dict[str, str]:
    """The sections of a Markdown text at one heading level, as title to body."""
    parts = re.split(rf"^{'#' * level} (.+)\n", text, flags=re.MULTILINE)
    return dict(zip(parts[1::2], parts[2::2]))


def readme() -> dict[str, str]:
    """The `##` sections of the README."""
    return sections((REPOSITORY / "README.md").read_text(encoding="utf-8"))


def command_lines(text: str) -> list[str]:
    """The lines of the `bash` code blocks of a Markdown text, a continued line joined to its start."""
    blocks = (block for language, block in FENCE.findall(text) if language == "bash")
    return [line.strip() for block in blocks
            for line in block.replace("\\\n", " ").splitlines() if line.strip()]


def table(text: str) -> tuple[str, list[list[str]]]:
    """The first table of a Markdown text.

    Returns:
        The text above the table, and the rows as lists of cells: the header row
        first, the divider row left out.
    """
    lines = text.splitlines()
    start = next(number for number, line in enumerate(lines) if line.startswith("|"))
    rows = [[cell.strip() for cell in line.strip("|").split("|")]
            for line in itertools.takewhile(lambda line: line.startswith("|"), lines[start:])]
    return "\n".join(lines[:start]), [rows[0], *rows[2:]]


def test_acc_cli_87_the_agent_section_has_upload_and_monitor_commands_for_each_board_family():
    """ACC-CLI-87 the README has the section Working with an AI agent with upload and monitor commands for AVR, STM32 and ESP boards."""
    families = sections(readme()["Working with an AI agent"], level=3)

    for family, expected in FAMILIES.items():
        titles = [title for title in families if family in title]
        assert len(titles) == 1, f"the agent section has {len(titles)} subsections for {family}"
        (title,) = titles
        commands = command_lines(families[title])
        for phrase in expected:
            assert any(phrase in command for command in commands), (
                f"no command line under `{title}` holds `{phrase}`")
        assert any(command.startswith(f"{PROGRAM}monitor read ") for command in commands), (
            f"no monitor command under `{title}`")


def test_acc_cli_87_every_command_line_of_the_readme_is_one_the_cli_accepts():
    """ACC-CLI-87 every `jupyterlab-device` command line in a code block of the README names only commands, arguments and flags that exist."""
    text = (REPOSITORY / "README.md").read_text(encoding="utf-8")
    commands = [shlex.split(line)[1:] for line in command_lines(text) if line.startswith(PROGRAM)]

    assert commands, "the README holds command lines of the CLI"
    for words in commands:
        # What follows `--` is the tool that `run` starts.
        own = words[:words.index("--")] if "--" in words else words
        try:
            cli.build_parser().parse_args(own)
        except SystemExit:
            pytest.fail(f"the CLI refuses the README's command line `{shlex.join(words)}`")


def test_acc_cli_88_the_readme_has_a_table_from_device_kind_to_windows_driver():
    """ACC-CLI-88 the README has a table from device kind to the Windows driver it needs, with five rows or more, marked as not tested."""
    above, (header, *rows) = table(readme()["Windows drivers"])

    assert (header[0], header[-1]) == ("Device kind", "Windows driver it needs")
    assert len(rows) >= 5
    assert all(row[0] and row[-1] for row in rows), "every row names a device kind and a driver"
    assert "from knowledge" in above and "not tested" in above


def test_acc_cli_89_the_readme_lists_the_six_limits_of_the_first_version():
    """ACC-CLI-89 the section Limits of the README has one bullet for each of the six limits of the brief."""
    bullets = [line for line in readme()["Limits"].splitlines() if line.startswith("- ")]

    found = {phrase: [bullet for bullet in bullets if phrase in bullet] for phrase in LIMITS}

    for phrase, matches in found.items():
        assert len(matches) == 1, f"the limit with `{phrase}` is in {len(matches)} bullets"
    assert len({matches[0] for matches in found.values()}) == len(LIMITS), "one bullet per limit"


def test_acc_cli_90_the_readme_says_how_the_shim_is_packaged():
    """ACC-CLI-90 the README says how the shim is packaged: C source in the wheel, built on first use with the system C compiler, not loaded by a statically linked tool."""
    shim = sections(readme()["Serial ports"], level=3)["Preload shim"]

    for phrase in ("C source", "pure Python", "on first use", "C compiler",
                   "~/.cache/jupyterlab-device-bridge/", "statically linked tool does not load"):
        assert phrase in shim, f"the shim passage lacks `{phrase}`"
    for compiler in shim_build.COMPILERS:
        assert f"`{compiler}`" in shim, f"the shim passage does not name the compiler {compiler}"


def test_acc_cli_90_the_readme_says_how_a_pyusb_program_is_pointed_at_the_backend():
    """ACC-CLI-90 the README says how a pyusb program is pointed at the backend, names pyOCD, and says that pyOCD was not run."""
    backend = sections(readme()["USB devices"], level=3)["pyusb backend"]

    functions = set(re.findall(r"pyusb_backend\.(\w+)\(\)", backend))

    assert {"get_backend", "install"} <= functions
    for name in functions:
        assert callable(getattr(pyusb_backend, name, None)), f"pyusb_backend has no {name}()"
    assert any("pyusb_backend.install()" in command and "pyocd" in command
               for command in command_lines(backend)), "a command line starts pyOCD after install()"
    assert "not run against pyOCD" in backend, "the passage says that pyOCD was not run"


def skill_rules() -> list[str]:
    """The bullets under `## Rules` of the agent skill."""
    rules = SKILL.read_text(encoding="utf-8").split("## Rules", 1)[1]
    return [line for line in rules.splitlines() if line.startswith("- ")]


def test_acc_term_174_the_skill_tells_an_agent_to_use_monitor_read_and_monitor_write_instead_of_terminal():
    """ACC-TERM-174 one rule of the agent skill says that `terminal` is for a person and tells an agent to read with `monitor read` and write with `monitor write` instead."""
    rules = [rule for rule in skill_rules() if "`terminal`" in rule]

    assert len(rules) == 1, f"{len(rules)} rules of the skill name `terminal`"
    (rule,) = rules
    assert "needs a person at a terminal" in rule
    assert "Agent reads with `monitor read` and writes with `monitor write`, never with `terminal`" in rule


# What the README and the skill must show of PlatformIO: the upload under `run`, the monitor,
# and the two keys of platformio.ini.
PIO_UPLOAD = f"{PROGRAM}run --device tty-2341-0043 -- pio run -t upload --upload-port /run/devices/tty-2341-0043"
PIO_MONITOR = "pio device monitor --port /run/devices/tty-2341-0043 --baud 115200"
PIO_FINDS_NOTHING = ("pio does not find the virtual device by itself: name its path with --upload-port for "
                     "an upload and with --port for pio device monitor, or set upload_port and monitor_port "
                     "in platformio.ini")


def test_acc_cli_184_the_readme_shows_pio_upload_and_monitor_and_how_pio_finds_the_virtual_device():
    """ACC-CLI-184 the README section Working with an AI agent has a subsection on PlatformIO with the upload line under `run` and the `pio device monitor` line in a `bash` block, the sentence that pio does not find the virtual device by itself, and a platformio.ini block with upload_port and monitor_port."""
    agent = sections(readme()["Working with an AI agent"], level=3)
    titles = [title for title in agent if "PlatformIO" in title]

    assert len(titles) == 1, f"the agent section has {len(titles)} subsections for PlatformIO"
    (title,) = titles
    text = agent[title]
    commands = command_lines(text)
    ini = [block for language, block in FENCE.findall(text) if language == "ini"]
    assert PIO_UPLOAD in commands and PIO_MONITOR in commands
    assert PIO_FINDS_NOTHING in " ".join(text.split())
    assert ini == ["[env:uno]\nupload_port = /run/devices/tty-2341-0043\n"
                   "monitor_port = /run/devices/tty-2341-0043\n"]


def test_acc_cli_184_the_skill_shows_pio_upload_and_monitor_and_names_the_path_options():
    """ACC-CLI-184 one rule of the agent skill names pio, shows the upload under `run --device <name> --` with --upload-port and the monitor with --port, and names upload_port and monitor_port of platformio.ini."""
    rules = [rule for rule in skill_rules() if "--upload-port" in rule]

    assert len(rules) == 1, f"{len(rules)} rules of the skill name --upload-port"
    (rule,) = rules
    for phrase in ("pio does not find the virtual device by itself",
                   "`run --device <name> -- pio run -t upload --upload-port <path>`",
                   "`pio device monitor --port <path>`",
                   "`upload_port` and `monitor_port` in `platformio.ini`"):
        assert phrase in rule, f"the pio rule of the skill lacks `{phrase}`"
