"""Stellars-Tech light and dark themes for Textual, chosen from the terminal's own background.

Textual switches CSS between light and dark only on its own theme setting; it never asks the
terminal. `pick_theme()` does, before the app starts, and `apply()` registers both brand themes
and selects one. Write CSS against the `$st-*` variables below and it follows the theme; a Rich
`Text` style that must follow it too reads `color(app, role)`.

Dark values are the established TUI palette; light values come from the LIGHT palette in
galaxahub/services/galaxahub/galaxahub-web/src/theme/tokens.ts.
"""

import os
import re
import select
import sys

from textual.app import App
from textual.theme import Theme

PALETTES = {
    "dark": {
        "screen": "#1a1f25", "chrome": "#2a313a", "surface": "#303841", "border": "#404b54",
        "text": "#c3c3c3", "muted": "#a5a5a5", "subtle": "#7d8791",
        "cyan": "#21a8e4", "cyan-bright": "#46bcf0", "orange": "#da8230",
        "amber": "#e6c660", "mint": "#3fb950", "rose": "#ef4444",
    },
    "light": {
        "screen": "#f5f7fa", "chrome": "#eef1f5", "surface": "#ffffff", "border": "#d4dde3",
        "text": "#1a3540", "muted": "#46606c", "subtle": "#607782",
        # emphasis is darker on a light ground: accentActive, not accentHover (3.8-4.3:1)
        "cyan": "#06709c", "cyan-bright": "#05607f", "orange": "#b5641b",
        "amber": "#9a6700", "mint": "#1a7f37", "rose": "#d94851",
    },
}


def _theme(mode: str) -> Theme:
    p = PALETTES[mode]
    return Theme(
        name=f"stellars-tech-{mode}",
        primary=p["cyan"], secondary=p["orange"], accent=p["orange"],
        warning=p["amber"], error=p["rose"], success=p["mint"],
        foreground=p["text"], background=p["screen"], surface=p["surface"], panel=p["chrome"],
        dark=mode == "dark",
        # prefixed so none shadows a Textual built-in ($surface, $border, $text)
        variables={f"st-{role}": value for role, value in p.items()},
    )


THEMES = {mode: _theme(mode) for mode in PALETTES}


def parse_osc11(reply: str) -> bool | None:
    """True for a dark background, False for light, None when the reply is not an OSC 11 colour.
    Terminals answer `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` with 1 to 4 hex digits per channel."""
    m = re.search(r"rgba?:([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})", reply)
    if not m:
        return None
    r, g, b = (int(h, 16) / (16 ** len(h) - 1) for h in m.groups())
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5


_DA1_REPLY = re.compile(rb"\033\[\?[\d;]*c")


def _ask_terminal(timeout: float = 1.0) -> bool | None:
    """Send the OSC 11 background query to the controlling terminal, then a device-attributes
    request, and read until the answer to the second. None when there is no terminal or it does
    not say. Every terminal answers the second, in order, so its answer means nothing more is on
    the way. A fixed wait is not enough: an answer that arrives after it reaches the app as key
    presses and is typed into the focused field."""
    try:
        import termios, tty
        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    except (ImportError, OSError):
        return None
    saved = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        os.write(fd, b"\033]11;?\033\\" + b"\033[c")
        reply = b""
        while not _DA1_REPLY.search(reply) and select.select([fd], [], [], timeout)[0]:
            reply += os.read(fd, 64)
        return parse_osc11(reply.decode(errors="replace"))
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        os.close(fd)


def _colorfgbg() -> bool | None:
    """rxvt and Konsole export COLORFGBG="fg;bg" as ANSI indexes; 0-6 and 8 are dark grounds."""
    bg = os.environ.get("COLORFGBG", "").split(";")[-1]
    return int(bg) in (0, 1, 2, 3, 4, 5, 6, 8) if bg.isdigit() else None


def pick_theme() -> str:
    """The theme name to start with. Order: TEXTUAL_THEME naming one of ours, the terminal's
    answer to OSC 11, COLORFGBG, then dark. Call it before App.run() - Textual owns the
    terminal afterwards."""
    wanted = os.environ.get("TEXTUAL_THEME", "")
    if wanted in (t.name for t in THEMES.values()):
        return wanted
    dark = _ask_terminal() if sys.stdin.isatty() else None
    if dark is None:
        dark = _colorfgbg()
    return THEMES["dark" if dark is not False else "light"].name


def apply(app: App, name: str) -> None:
    """Register both brand themes and select one. Call it in __init__, after super().__init__():
    the stylesheet is parsed before on_mount, and a `$st-*` variable that is not yet defined
    there fails the parse with UnresolvedVariableError. With TEXTUAL_THEME naming the theme,
    Textual is already set to `name` before that theme exists, and assigning the same name again
    changes nothing, so the other theme is selected first."""
    for theme in THEMES.values():
        app.register_theme(theme)
    if app.theme == name:
        app.theme = next(t.name for t in THEMES.values() if t.name != name)
    app.theme = name


def color(app: App, role: str) -> str:
    """The current hex for a role, for Rich `Text` styles that CSS cannot reach."""
    return app.theme_variables[f"st-{role}"]
