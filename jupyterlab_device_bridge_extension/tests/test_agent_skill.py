"""The agent skill of the `jupyterlab-device` CLI: where it is, what it names, and that the wheel installs it.

The skill ships twice: the repository copy an agent reads from a clone, and the copy
the wheel's shared-data mapping puts under `sys.prefix`. Two copies drift, so they are
compared byte for byte here, `SKILL.md` and every file of `references/` alike. The
firmware environment installers are not part of this extension: they live in the
template of the copier embedded project, and ACC-CLI-238 holds this extension to that.
"""

import ast
import importlib.util
import os
import pathlib
import re
import select
import sys
import threading
import tomllib
import zipfile

import pytest

from .test_cli import PARSERS

SKILL_NAME = "jupyterlab-device-bridge-extension"
REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
REPOSITORY_COPY = REPOSITORY / ".agents" / "skills" / SKILL_NAME / "SKILL.md"
INSTALLED_COPY = pathlib.Path(sys.prefix) / "share" / "jupyter" / "agents" / "skills" / SKILL_NAME / "SKILL.md"
REFERENCES = REPOSITORY_COPY.parent / "references"
INSTALLED_REFERENCES = INSTALLED_COPY.parent / "references"
FAQ = REFERENCES / "faq.md"
BOARDS = REFERENCES / "boards.md"
DEVICE_REFERENCE = REFERENCES / "device-reference.md"
TURMO = REFERENCES / "devices" / "turmo-usb-monitor.md"
# The sections of a device reference, in order (ACC-CLI-248).
SECTIONS = ("Identity", "Connection", "Device protocol", "Device code", "Host protocol",
            "Host code", "Traps and recovery", "Observed and untested", "Sources")
# The symptoms of ACC-CLI-214; the first cell of the row of each, in order.
FAQ_SYMPTOMS = (
    "A refused run",
    "No serial data",
    "A wrong bootloader baud",
    "A pty that refuses parity",
    "Binary monitor output",
    "A removed port",
    "A held port",
)
ENVS = REPOSITORY / "resources" / "envs"
INSTALLED_ENVS = INSTALLED_COPY.parent / "envs"
INSTALLERS = ("firmware-avr.py", "firmware-stm32.py", "firmware-esp.py", "firmware_env.py")
# Tools whose own command lines the skill shows; their flags are not flags of the CLI.
TOOLS = ("pio",)
# Where the installers live now: the template of the copier embedded project, not this
# extension. ACC-CLI-238 keeps them out of the repository, the build and the wheel.
TEMPLATE_URL = "https://github.com/stellarshenson/copier-embedded-project"

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


def own_words(rules: str) -> str:
    """The rules without the words of other programs: a code span that starts with a tool, the part of a span after ` -- `, the tool that `run` starts, and the device placeholder that `--device` takes."""
    def cut(span: re.Match) -> str:
        words = span.group(1)
        return "``" if words.split()[0] in TOOLS else f"`{words.split(' -- ')[0].replace(' <name>', '')}`"
    return re.sub(r"`([^`]+)`", cut, rules)


def test_acc_cli_86_the_skill_names_only_commands_and_flags_that_exist():
    """ACC-CLI-86 every flag and every command the skill names in backticks is one the CLI has; the words of a tool that the skill shows are not the CLI's."""
    rules = own_words(REPOSITORY_COPY.read_text().split("## Rules", 1)[1])
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


def test_acc_cli_238_the_repository_and_the_install_hold_no_environment_installers():
    """ACC-CLI-238 resources/envs is absent, the repository holds no firmware installer, none is under the installed skill, and pyproject.toml maps no envs folder into the wheel."""
    shared = tomllib.loads((REPOSITORY / "pyproject.toml").read_text())[
        "tool"]["hatch"]["build"]["targets"]["wheel"]["shared-data"]
    installed = [path for path in INSTALLED_ENVS.iterdir() if path.is_file()] if INSTALLED_ENVS.is_dir() else []
    shipped = sorted(path for folder in ("resources", ".agents", "jupyterlab_device_bridge_extension")
                     for path in (REPOSITORY / folder).rglob("firmware[-_]*.py"))

    assert not ENVS.exists(), f"{ENVS} is still in the repository"
    assert not shipped, f"the repository holds installers: {shipped}"
    assert not installed, f"the installed skill holds {installed}"
    assert not [key for key in shared if "envs" in key or "envs" in shared[key]], shared


def test_acc_cli_238_the_built_wheel_carries_no_environment_installers():
    """ACC-CLI-238 no wheel in dist holds an envs folder or a firmware installer."""
    wheels = sorted((REPOSITORY / "dist").glob("*.whl"))
    if not wheels:
        pytest.skip("no wheel in dist - run make install")

    offenders = {}
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            found = [name for name in archive.namelist()
                     if "/envs/" in name or name.startswith("envs/")
                     or re.fullmatch(r"firmware[-_].*\.py", pathlib.PurePosixPath(name).name)]
        if found:
            offenders[wheel.name] = found

    assert not offenders, f"wheels carry environment installers: {offenders}"


def test_acc_cli_238_the_skill_and_the_readme_point_to_the_copier_embedded_project_template():
    """ACC-CLI-238 the skill and the README name the copier embedded project template URL and its template/resources/envs folder, and state that this extension ships no installer."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    readme = (REPOSITORY / "README.md").read_text(encoding="utf-8")
    lines = [line for line in skill.split("## Rules", 1)[1].splitlines() if "firmware-" in line]

    assert len(lines) == 1, f"{len(lines)} rules of the skill name a firmware installer"
    (rule,) = lines
    assert TEMPLATE_URL in rule
    assert "`template/resources/envs`" in rule
    for name in INSTALLERS:
        assert f"`{name}`" in rule, name
    assert "This extension ships none" in rule
    assert "Ask user before running one" in rule
    assert TEMPLATE_URL in readme
    assert "No installer is in this repository or in the wheel" in readme


def test_acc_cli_135_one_rule_of_the_skill_says_that_the_devices_panel_lists_a_run_and_that_the_user_can_stop_it():
    """ACC-CLI-135 one rule of the skill states that the Devices panel of the lab lists a tool started under `run --` and that the user can stop it there."""
    rules = REPOSITORY_COPY.read_text().split("## Rules", 1)[1]
    lines = [line for line in rules.splitlines() if "user can stop it there" in line]

    assert len(lines) == 1, f"{len(lines)} rules of the skill say that the user can stop a run"
    (rule,) = lines
    assert "under `run --device <name> --`" in rule
    assert "Devices panel of the lab (if no sidebar has the panel: menu View, item Show Devices Panel) lists it" in rule


def test_acc_cli_146_the_skill_has_one_rule_for_shell_and_does_not_hold_the_old_line():
    """ACC-CLI-146 the skill does not hold `run -- "$SHELL"` nor the variable in that form, and one rule says that `shell` is a device shell for a person and that an agent starts each tool under `run --device <name> --`."""
    skill = REPOSITORY_COPY.read_text()
    lines = [line for line in skill.split("## Rules", 1)[1].splitlines() if "`shell`" in line]

    assert "$SHELL" not in skill and 'run -- "' not in skill
    assert len(lines) == 1, f"{len(lines)} rules of the skill name the command shell"
    (rule,) = lines
    assert "device shell for a person at a terminal" in rule
    assert "Agent starts each tool under `run --device <name> --`" in rule


def test_acc_cli_214_the_installed_references_are_the_repository_copies():
    """ACC-CLI-214 the wheel installs every file of the skill's references folder, byte for byte the repository copy."""
    files = {path.relative_to(REFERENCES) for path in REFERENCES.rglob("*") if path.is_file()}
    installed = ({path.relative_to(INSTALLED_REFERENCES)
                  for path in INSTALLED_REFERENCES.rglob("*") if path.is_file()}
                 if INSTALLED_REFERENCES.is_dir() else set())

    assert files, "the skill has references"
    assert installed == files, (
        f"the installed references {sorted(map(str, installed))} are not the repository's "
        f"{sorted(map(str, files))} - run make install")
    for relative in sorted(files):
        assert (INSTALLED_REFERENCES / relative).read_bytes() == (REFERENCES / relative).read_bytes(), (
            f"the installed {relative} differs from the repository copy - run make install")


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip("|").split("|")]


def faq_rows() -> tuple[list[str], list[list[str]]]:
    """The header and the body rows of the one table of faq.md."""
    table = [line for line in FAQ.read_text(encoding="utf-8").splitlines() if line.startswith("|")]
    return _cells(table[0]), [_cells(line) for line in table[2:]]


def test_acc_cli_214_the_faq_has_one_row_for_each_symptom():
    """ACC-CLI-214 faq.md has the columns Symptom, Probe, Cause and Next step, and exactly one row for each symptom the criterion names, whose probe names a command."""
    header, rows = faq_rows()

    assert header == ["Symptom", "Probe", "Cause", "Next step"]
    for symptom in FAQ_SYMPTOMS:
        found = [row for row in rows if row[0].lower() == symptom.lower()]
        assert len(found) == 1, f"{len(found)} rows for {symptom}"
        row = found[0]
        assert len(row) == 4 and all(row), row
        assert "jupyterlab-device" in row[1], f"the probe of {symptom} names a command: {row[1]}"


def test_acc_cli_214_the_faq_names_the_esptool_5_6_failure_and_the_server_restart():
    """ACC-CLI-214 faq.md has a row for the ESP8266 erase that esptool 5.6 fails and a row for the package newer than the running server, whose next step is a restart of JupyterLab."""
    text = FAQ.read_text(encoding="utf-8").lower()

    assert "esptool 5.6" in text and "c400" in text and "esptool 4.11" in text
    assert "keyerror" in text and "no device bridge" in text and "restart jupyterlab" in text


def test_acc_cli_214_the_skill_tells_the_agent_to_probe_before_retrying():
    """ACC-CLI-214 one rule of the skill says to probe before retrying, names the four probe subcommands, and the References line lists faq.md."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    lines = [line for line in skill.split("## Rules", 1)[1].splitlines()
             if "probe before retrying" in line.lower()]

    assert len(lines) == 1, f"{len(lines)} rules say to probe before retrying"
    (rule,) = lines
    for name in ("baud", "avr", "stm32", "esp"):
        assert f"`probe {name}`" in rule, name
    assert "`references/faq.md`" in skill.split("## References", 1)[1]


def test_acc_cli_215_the_boards_reference_tells_the_nano_bootloaders_apart_and_the_upload_form_of_each():
    """ACC-CLI-215 boards.md has a Nano bootloader section that tells the old 57600 bootloader from the new 115200 one and gives an avrdude form for each."""
    boards = BOARDS.read_text(encoding="utf-8")

    assert "### Nano bootloaders" in boards
    section = boards.split("### Nano bootloaders", 1)[1].split("\n## ", 1)[0]
    for fact in ("Old bootloader: ATmegaBOOT, 57600 baud",
                 "New bootloader: Optiboot, 115200 baud",
                 "-b 57600", "-b 115200",
                 "upload_speed = 57600", "upload_speed = 115200"):
        assert fact in section, fact
    assert section.count("jupyterlab-device run --device <name> -- avrdude") == 2


def test_acc_cli_215_the_boards_reference_tells_how_to_burn_optiboot_with_an_isp_programmer():
    """ACC-CLI-215 boards.md tells how to burn optiboot through an ISP programmer: the Arduino as ISP config, the avrdude line with the hex and the Nano fuses, and that the burn is manual."""
    boards = BOARDS.read_text(encoding="utf-8")
    section = boards.split("### Nano bootloaders", 1)[1].split("\n## ", 1)[0]

    for fact in ("Burn optiboot with an ISP programmer", "manual", "ICSP",
                 "Arduino as ISP", "-c stk500v1", "optiboot_atmega328.hex",
                 "-U flash:w:optiboot_atmega328.hex:i", "0xFF", "0xDA", "0xFD"):
        assert fact in section, fact


def test_acc_board_102_the_boards_reference_records_the_esp8266_recipe():
    """ACC-BOARD-102 boards.md records the ESP8266 board that was exercised, the esptool 4.11 writes at 0x700000 and 0x701000 with the hash verified, and the esptool 5.6 erase failure."""
    boards = BOARDS.read_text(encoding="utf-8")
    section = boards.split("## ESP8266", 1)[1].split("\n## ", 1)[0]

    for fact in ("0x002a6be1", "CP210x", "esptool 4.11",
                 "0x700000", "0x701000", "Hash of data verified",
                 "esptool 5.6", "C400 Failed SPI operation in stub", "0x0106",
                 "--before no_reset", "write_flash"):
        assert fact in section, fact


def section(path: pathlib.Path, number: int) -> str:
    """The text of the numbered `## <number>. <title>` section of a reference file, up to the next `## ` heading."""
    text = path.read_text(encoding="utf-8")
    match = re.search(rf"^## {number}\. .*?(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    assert match, f"{path.name} has no section {number}"
    return match.group(0)


def host_code_block(name: str) -> str:
    """The code block of the Host code subsection of the TURMO reference that is titled with the file name."""
    match = re.search(rf"^### 6\.\d+ {re.escape(name)}\n.*?^```[a-z]+\n(.*?)^```$",
                      section(TURMO, 6), re.MULTILINE | re.DOTALL)
    assert match, f"the Host code section holds no block for {name}"
    return match.group(1)


def in_order(text: str, phrases: tuple[str, ...]) -> None:
    """Each phrase occurs in the text, each after the one before it."""
    position = 0
    for phrase in phrases:
        found = text.find(phrase, position)
        assert found >= 0, f"{phrase!r} is missing or out of order"
        position = found + len(phrase)


@pytest.fixture(scope="module")
def turmo(tmp_path_factory):
    """The turmo.py block of the TURMO reference, saved to a file and imported."""
    path = tmp_path_factory.mktemp("turmo") / "turmo.py"
    path.write_text(host_code_block("turmo.py"))
    spec = importlib.util.spec_from_file_location("turmo_reference_block", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_acc_cli_248_device_reference_states_the_nine_sections_in_order():
    """ACC-CLI-248 the Format table of device-reference.md names the nine sections in order, each with what it holds; Device protocol and Device code are the device side, Host protocol and Host code the host side."""
    rows = [_cells(line) for line in section(DEVICE_REFERENCE, 1).splitlines() if line.startswith("|")]
    header, body = rows[0], rows[2:]

    assert header == ["Section", "Side", "Holds"]
    assert [row[0] for row in body] == list(SECTIONS)
    for name, side, holds in body:
        assert len(holds.split()) >= 5, f"{name} says too little about what it holds: {holds}"
    sides = {row[0]: row[1] for row in body}
    assert sides["Device protocol"] == sides["Device code"] == "device"
    assert sides["Host protocol"] == sides["Host code"] == "host"
    assert "`## 1. Identity` to `## 9. Sources`" in section(DEVICE_REFERENCE, 1)


def test_acc_cli_249_device_reference_holds_the_research_procedure_in_order():
    """ACC-CLI-249 the procedure of device-reference.md has numbered steps in order: list, existing reference, web lookup after the user agrees, datasheets to references/datasheets/<part>-<document>.pdf never executed, harmless probe without reset or erase, write, user confirmation."""
    procedure = section(DEVICE_REFERENCE, 3)
    steps = re.findall(r"^(\d+)\. ", procedure, re.MULTILINE)

    assert steps == [str(number) for number in range(1, len(steps) + 1)] and len(steps) >= 7
    assert "Web lookups and downloads run only after the user agrees" in procedure
    in_order(procedure, (
        "`jupyterlab-device list`",
        "existing reference in `references/devices/`",
        "Ask the user to agree to a web lookup",
        "`references/datasheets/<part>-<document>.pdf`",
        "never execute it",
        "as not found",
        "harmless reads first",
        "Never send reset, erase or write commands before the protocol is known",
        "Write the reference",
        "Ask the user to confirm what the device did",
    ))


def test_acc_cli_250_device_reference_saves_only_into_a_copier_embedded_project():
    """ACC-CLI-250 the save rule names references/devices/<device>.md, the .copier-answers.yml check, the copier command, writes nothing elsewhere, and asks before making references/."""
    rule = section(DEVICE_REFERENCE, 2)

    for fact in ("`references/devices/<device>.md`",
                 "`.copier-answers.yml`", "`copier-embedded-project`",
                 "`copier copy --trust https://github.com/stellarshenson/copier-embedded-project <dir>`",
                 "write nothing elsewhere",
                 "ask the user before making `references/`"):
        assert fact in rule, fact


def test_acc_cli_245_turmo_reference_has_the_uniform_sections_and_the_observed_facts():
    """ACC-CLI-245 the TURMO reference has the nine sections in order, the vendor firmware UsbPCMonitor not available, the dated observed facts, the wrap fix untested, datasheets by part, URL and file, no RESET in host code and no path into tmp/."""
    text = TURMO.read_text(encoding="utf-8")
    headings = re.findall(r"^## \d+\. (.+)$", text, re.MULTILINE)
    observed = section(TURMO, 8)
    host_code = "".join(host_code_block(name) for name in ("turmo.py", "gpu_status.py", "dashboard.html"))
    datasheets = [_cells(line) for line in section(TURMO, 9).splitlines() if line.startswith("| Part ")]

    assert headings == list(SECTIONS)
    assert "closed vendor firmware, UsbPCMonitor" in section(TURMO, 4) and "not available" in section(TURMO, 4)
    assert "1a86:5722" in section(TURMO, 1)
    assert "2026-10-19" in observed and "307234 bytes" in observed and "power-cycled" in observed
    assert re.search(r"^- \*\*Wrap after the strict send\*\* - untested", observed, re.MULTILINE)
    assert datasheets == [["Part", "URL", "File"]]
    assert "reset" not in host_code.lower() and "0x65" not in host_code
    assert not re.search(r"(?<![/\w])tmp/", text) and "/home/" not in text
    assert text.isascii()


def test_acc_cli_247_turmo_py_builds_the_exact_packets_and_pixels(turmo):
    """ACC-CLI-247 the extracted turmo.py builds HELLO, the portrait orientation, brightness 80, the 320 x 480 bitmap header and RGB565 little-endian pixels as the exact bytes, on the standard library only."""
    imported = {alias.name.split(".")[0] for node in ast.walk(ast.parse(host_code_block("turmo.py")))
                if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in getattr(node, "names", [])}

    assert imported <= sys.stdlib_module_names, imported - sys.stdlib_module_names
    assert turmo.hello() == bytes.fromhex("45 45 45 45 45 45")
    assert turmo.orientation_portrait() == bytes.fromhex("00 00 00 00 00 79 64 01 40 01 e0 00 00 00 00 00")
    assert turmo.brightness(80) == bytes.fromhex("0c c0 00 00 00 6e")
    assert turmo.bitmap_header(0, 0, 320, 480) == bytes.fromhex("00 00 04 fd df c5")
    assert turmo.rgb565(255, 0, 0) == bytes.fromhex("00 f8")
    assert turmo.rgb565(0, 255, 0) == bytes.fromhex("e0 07")
    assert turmo.rgb565(0, 0, 255) == bytes.fromhex("1f 00")
    assert turmo.rgb565(255, 255, 255) == bytes.fromhex("ff ff")
    assert turmo.to_rgb565(bytes([255, 0, 0, 0, 0, 255])) == bytes.fromhex("00 f8 1f 00")


def test_acc_cli_247_the_strict_send_writes_every_part_alone_through_a_pty(turmo, monkeypatch):
    """ACC-CLI-247 the strict send of turmo.py writes HELLO, the orientation, the brightness and the header each alone, then 120 writes of 2560 bytes, 307234 bytes in total, read back unchanged from the other side of an os.openpty pair that answers HELLO."""
    master, slave = os.openpty()
    fd = turmo.open_device(os.ttyname(slave))
    frame = bytes(range(256)) * 1200
    received = bytearray()

    def panel():
        while len(received) < 307234 and select.select([master], [], [], 10)[0]:
            received.extend(os.read(master, 65536))
            if len(received) == 6:
                os.write(master, bytes([0x01] * 6))

    writes = []
    real_write = os.write

    def record(target, data):
        if target == fd:
            writes.append(bytes(data))
        return real_write(target, data)

    reader = threading.Thread(target=panel, daemon=True)
    reader.start()
    monkeypatch.setattr(os, "write", record)
    try:
        sent = turmo.send_frame(fd, frame)
        reader.join(10)
    finally:
        for descriptor in (fd, slave, master):
            os.close(descriptor)

    expected = [bytes.fromhex("45 45 45 45 45 45"),
                bytes.fromhex("00 00 00 00 00 79 64 01 40 01 e0 00 00 00 00 00"),
                bytes.fromhex("0c c0 00 00 00 6e"),
                bytes.fromhex("00 00 04 fd df c5")]
    expected += [frame[start:start + 2560] for start in range(0, 307200, 2560)]
    assert sent == 307234
    assert len(writes) == 124 and writes == expected
    assert bytes(received) == b"".join(expected)


def test_acc_cli_247_the_strict_send_stops_after_an_unanswered_hello(turmo, monkeypatch):
    """ACC-CLI-247 HELLO times out on a pty that reads and never answers, and the strict send then writes nothing after it."""
    master, slave = os.openpty()
    fd = turmo.open_device(os.ttyname(slave))
    stop = threading.Event()

    def silent_panel():
        while not stop.is_set():
            if select.select([master], [], [], 0.1)[0]:
                os.read(master, 65536)

    writes = []
    real_write = os.write
    monkeypatch.setattr(os, "write", lambda target, data: writes.append(bytes(data)) or real_write(target, data))
    reader = threading.Thread(target=silent_panel, daemon=True)
    reader.start()
    try:
        assert turmo.say_hello(fd, timeout=0.2) == b""
        with pytest.raises(RuntimeError, match="nothing more sent"):
            turmo.send_frame(fd, bytes(307200))
    finally:
        stop.set()
        reader.join(5)
        for descriptor in (fd, slave, master):
            os.close(descriptor)

    assert writes == [bytes.fromhex("45 45 45 45 45 45")] * 2


def test_acc_cli_247_the_host_code_holds_gpu_status_and_the_dashboard_with_their_commands():
    """ACC-CLI-247 gpu_status.py compiles and holds the nvidia-smi sample, the 2x render, the downscale, --device, --dry-run and --out; dashboard.html holds the render function; the Host code section names the commands that run them."""
    gpu_status = host_code_block("gpu_status.py")
    commands = section(TURMO, 6)

    compile(gpu_status, "gpu_status.py", "exec")
    for fact in ("nvidia-smi", "device_scale_factor=2", "Image.LANCZOS", "turmo.send_frame",
                 '"--device"', '"--dry-run"', '"--out"'):
        assert fact in gpu_status, fact
    assert "function render(snapshot)" in host_code_block("dashboard.html")
    for command in ("python3 turmo.py hello --device /run/devices/tty-1a86-5722",
                    "python3 gpu_status.py --dry-run --out gpu_status.png",
                    "python3 gpu_status.py --device /run/devices/tty-1a86-5722"):
        assert command in commands, command


def test_acc_cli_246_the_skill_names_both_reference_files_and_the_install_carries_them():
    """ACC-CLI-246 SKILL.md has under 30 lines and its References line names device-reference.md and devices/turmo-usb-monitor.md; each installed copy equals the repository file byte for byte."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    references = skill.split("## References", 1)[1]

    assert len(skill.splitlines()) < 30
    for path in (DEVICE_REFERENCE, TURMO):
        relative = path.relative_to(REFERENCES)
        assert f"`references/{relative.as_posix()}`" in references, relative
        installed = INSTALLED_REFERENCES / relative
        assert installed.is_file(), f"{installed} is missing - run make install"
        assert installed.read_bytes() == path.read_bytes(), f"the installed {relative} differs - run make install"


def test_acc_cli_256_the_skill_names_the_board_references_in_the_copier_repository():
    """ACC-CLI-256-BOARD-REFS the References line names the board references in the copier-embedded-project repository and their per-board HTML path, inside the under-30-line limit."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    references = skill.split("## References", 1)[1]

    assert f"{TEMPLATE_URL}/tree/main/references/boards" in references
    assert "`references/boards/<board>/<board>.html`" in references
    assert len(skill.splitlines()) < 30


def test_acc_cli_257_the_skill_names_the_board_reference_skill_of_the_copier_project():
    """ACC-CLI-257-BOARD-SKILL the References line names the board-reference skill of the copier-embedded-project and that it builds one HTML page per board, inside the under-30-line limit."""
    skill = REPOSITORY_COPY.read_text(encoding="utf-8")
    references = skill.split("## References", 1)[1]

    assert f"{TEMPLATE_URL}/tree/main/.agents/skills/board-reference" in references
    assert "`board-reference`" in references
    assert len(skill.splitlines()) < 30
