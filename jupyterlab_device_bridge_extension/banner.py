"""The banner that `jupyterlab-device shell` prints on a terminal before it becomes the shell.

The banner is for a person. It opens with DEVICE BRIDGE in block letters, then the name
line and four sections under titled rules: the environment of the shell and its upload
tools, the attached devices, the agent skill and the commands. It is 75% of the terminal's
columns wide; the two words stand on one row when that width holds them, else one above
the other. The colours come from the palettes of the serial terminal, dark or light after
the terminal's background (`tui_theme`).

Unlike `cli.py`, which an agent reads, this file holds the characters of the logo as they are.
"""

import os
import sys
from pathlib import Path

from . import __version__

SKILL = "jupyterlab-device-bridge-extension"
# The share of the terminal's columns that the banner takes.
SHARE = 0.75
INDENT = "  "

# The letters in the ANSI Shadow figlet font: the full blocks draw a letter, the box
# characters its shadow.
_LETTERS = {
    "B": ("██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "),
    "C": (" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"),
    "D": ("██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "),
    "E": ("███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"),
    "G": (" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "),
    "I": ("██╗", "██║", "██║", "██║", "██║", "╚═╝"),
    "R": ("██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"),
    "V": ("██╗   ██╗", "██║   ██║", "██║   ██║", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚═══╝  "),
}


def _word(word: str) -> list[str]:
    return ["".join(_LETTERS[letter][row] for letter in word) for row in range(6)]


DEVICE, BRIDGE = _word("DEVICE"), _word("BRIDGE")
# The logo stands one column in. Under LOGO_COLUMNS the terminal gets no logo.
LOGO_COLUMNS = 1 + len(DEVICE[0])
WIDE_COLUMNS = 1 + len(DEVICE[0]) + 2 + len(BRIDGE[0])
# The roles the palettes of `tui_theme` do not have: the hues of a device and of its information.
EXTRA = {
    "dark": {"device": "#9fe0ee", "info": "#a8dcc4"},
    "light": {"device": "#0b6f8f", "info": "#2e7d5b"},
}
COMMANDS = (
    ("jupyterlab-device list", "devices and paths"),
    ("jupyterlab-device profile <dev> <id>", "set a board profile"),
    ("jupyterlab-device monitor read <dev>", "what a board sent"),
    ("jupyterlab-device terminal <dev>", "serial terminal"),
    ("jupyterlab-device help", "commands, examples"),
)


def palette() -> dict | None:
    """The colours of the banner; None when the variable NO_COLOR is set and not empty."""
    if os.environ.get("NO_COLOR"):
        return None
    from . import tui_theme  # Textual is loaded only for a banner with colour
    mode = "light" if tui_theme.pick_theme().endswith("light") else "dark"
    return {**tui_theme.PALETTES[mode], **EXTRA[mode]}


def skill_folder(prefix: str = sys.prefix) -> Path:
    """The folder in which the wheel installs the agent skill."""
    return Path(prefix) / "share" / "jupyter" / "agents" / "skills" / SKILL


def skill_state(prefix: str = sys.prefix, home: Path | None = None) -> tuple[Path | None, str | None]:
    """Where the agent skill is, and how an agent finds it.

    Returns:
        The SKILL.md that the wheel installed under `prefix`, None when it is not there; and
        `linked in <folder>` or `listed by <skill>`, None when no agent finds it.
    """
    folder = skill_folder(prefix)
    if not (folder / "SKILL.md").is_file():
        return None, None
    home = Path.home() if home is None else home
    bases = [home / ".agents" / "skills", home / ".claude" / "skills"]
    for base in bases:
        if (base / SKILL / "SKILL.md").is_file():
            return folder / "SKILL.md", f"linked in {_tilde(base, home)}"
    # A skill that lists the skills of the installed packages, such as GalaxaLab's, names the path.
    for base in bases:
        for other in sorted(base.glob("*/SKILL.md")):
            try:
                if str(folder) in other.read_text(errors="replace"):
                    return folder / "SKILL.md", f"listed by {_tilde(other.parent, home)}"
            except OSError:
                continue
    return folder / "SKILL.md", None


def _tilde(path: Path, home: Path) -> str:
    return f"~/{path.relative_to(home)}" if path.is_relative_to(home) else str(path)


def render(environment, known_tools: list[str], devices: list[tuple[str, str, str]] | None,
           columns: int, colours: dict | None) -> str:
    """The banner as one string: lines, the colour reset and an empty line.

    Args:
        environment: The `environments.Environment` the shell starts in.
        known_tools: The names of the known upload tools.
        devices: `(kind, name or path, information)` of each device attached without an
            error, `COM` before `USB`; None when the devices could not be read.
        columns: The columns of the terminal.
        colours: `palette()`; None for a banner without an escape sequence.
    """
    width = min(columns, max(LOGO_COLUMNS, int(columns * SHARE)))
    lines = [*_logo(width, colours), _name_line(width), []]
    lines.append(_rule("Environment", width))
    if environment.tools:
        where = environment.name if environment.prefix is None else f"{environment.name} ({environment.scope})"
        lines.append([(INDENT + where + " with ", "text"), (", ".join(environment.tools), "cyan-bright")])
    else:
        lines += [[(INDENT + environment.name, "text")],
                  [(f"{INDENT}No {', '.join(known_tools[:-1])} or {known_tools[-1]} on PATH.", "amber")],
                  [(INDENT + "Install one to make use of the device shell.", "text")]]
    if devices is not None:
        lines.append(_rule("Devices", width))
        if not devices:
            lines.append([(INDENT + "No device is attached. Add one in the Devices panel of the lab.", "text")])
        column = max(len(name) for _, name, _ in devices) if devices else 0
        lines += _pairs([([(INDENT + "● ", "mint"), (f"{kind}  ", "muted"), (name.ljust(column), "device")],
                          [(info, "info")]) for kind, name, info in devices], width, 9)
    lines.append(_rule("Agent skill", width))
    lines += _skill_lines(width)
    lines.append(_rule("Commands", width))
    column = max(len(command) for command, _ in COMMANDS)
    lines += _pairs([([(INDENT + command.ljust(column), "cyan")], [(what, "muted")]) for command, what in COMMANDS],
                    width, 6)
    lines.append([("─" * width, "subtle")])
    if colours is None:
        return "".join(_plain(line) + "\n" for line in lines) + "\n"
    return "".join(_coloured(line, colours) + "\n" for line in lines) + "\x1b[0m\n"


def _logo(width: int, colours: dict | None) -> list:
    """The rows of the logo and an empty line; nothing on a terminal too narrow for it.

    The full blocks get a colour of the diagonal gradient from cyan to mint, the box
    characters the colour of the shadow.
    """
    if width < LOGO_COLUMNS:
        return []
    rows = [d + "  " + b for d, b in zip(DEVICE, BRIDGE)] if width >= WIDE_COLUMNS else DEVICE + BRIDGE
    if colours is None:
        return [[(" " + row, None)] for row in rows] + [[]]
    start, end = _rgb(colours["cyan-bright"]), _rgb(colours["mint"])
    across, down = max(len(row) for row in rows) - 1, len(rows) - 1
    logo = []
    for y, row in enumerate(rows):
        line = [(" ", None)]
        for x, char in enumerate(row):
            if char == "█":
                share = (x / across + y / down) / 2
                hue = "#" + "".join(f"{round(a + (b - a) * share):02x}" for a, b in zip(start, end))
            line.append((char, hue if char == "█" else "subtle" if char != " " else None))
        logo.append(line)
    return [*logo, []]


def _name_line(width: int) -> list:
    name = f" ◆ jupyterlab-device {__version__}"
    gap = max(2, width - len(name) - len("device shell"))
    return [(" ◆ ", "orange"), ("jupyterlab-device", "cyan-bright"), (f" {__version__}", "muted"),
            (" " * gap + "device shell", "muted")]


def _rule(title: str, width: int) -> list:
    return [("── ", "subtle"), (title, "muted"), (" " + "─" * max(2, width - len(title) - 4), "subtle")]


def _pairs(pairs: list, width: int, indent: int) -> list:
    """Each `(left, right)` on one line; when one of these lines would be wider than `width`,
    each `right` on the line under its `left`, `indent` columns in."""
    if all(len(_text(left)) + 2 + len(_text(right)) <= width for left, right in pairs):
        return [[*left, ("  ", None), *right] for left, right in pairs]
    return [line for left, right in pairs for line in (left, [(" " * indent, None), *right])]


def _skill_lines(width: int) -> list:
    path, finder = skill_state()
    if path is None:
        return _pairs([([(INDENT + SKILL, "text")], [(f"not installed under {sys.prefix}", "amber")])], width, 4)
    state = [("✓ " + finder, "mint")] if finder else [("○ no agent finds it", "amber")]
    lines = _pairs([([(INDENT + SKILL, "text")], state)], width, 4) + [[(INDENT + str(path), "device")]]
    if not finder:
        lines.append([(INDENT + "jupyterlab-device help names the two commands that link it", "muted")])
    return lines


def _text(line: list) -> str:
    return "".join(text for text, _ in line)


def _plain(line: list) -> str:
    return _text(line).rstrip()


def _rgb(colour: str) -> tuple[int, int, int]:
    return int(colour[1:3], 16), int(colour[3:5], 16), int(colour[5:7], 16)


def _coloured(line: list, colours: dict) -> str:
    """The line with a 24-bit colour before each piece; a role names a colour of `colours`, a piece of the logo has its own."""
    out, last = "", None
    for text, role in line:
        if role is not None and role != last:
            r, g, b = _rgb(role if role.startswith("#") else colours[role])
            out += f"\x1b[38;2;{r};{g};{b}m"
            last = role
        out += text
    return out.rstrip()
