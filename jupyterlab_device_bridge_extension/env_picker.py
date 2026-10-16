"""The selector of the environment in which a device shell starts, a Textual list.

The first entry keeps the current environment; one entry follows for each environment
found, with its name, `project` or `global`, and its upload tools. Enter starts the shell
in the highlighted environment, Esc and Ctrl+C keep the current one.
"""

import os

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import Footer, OptionList, Static

from . import __version__, tui_theme
from .environments import Environment

# WSL leaves COLORTERM unset, and Textual then reduces the brand colours to 256.
os.environ.setdefault("COLORTERM", "truecolor")


def _entry(environment: Environment, width: int) -> str:
    """One line of the list: name, scope and tools in columns."""
    scope = "" if environment.scope == "current" else environment.scope
    tools = ", ".join(environment.tools) or "no upload tool"
    return f"{environment.name:<{width}}  {scope:<7}  {tools}"


class EnvironmentPicker(App[Environment]):
    """Asks in which environment the device shell starts; `run()` returns the chosen one."""

    ENABLE_COMMAND_PALETTE = False
    CSS = """
    Screen { background: $st-screen; color: $st-text; }
    #app-header { height: 1; background: $st-chrome; }
    #hdr-title { width: 1fr; color: $st-cyan-bright; text-style: bold; padding: 0 1; }
    #hdr-version { width: auto; color: $st-muted; padding: 0 1; }
    #question { padding: 1 1 0 1; color: $st-text; }
    OptionList { height: auto; margin: 1 1; background: $st-screen; color: $st-text; border: round $st-border; }
    OptionList:focus { border: round $st-cyan; }
    OptionList > .option-list--option-highlighted,
    OptionList:focus > .option-list--option-highlighted {
        background: $st-surface; color: $st-cyan-bright; text-style: bold;
    }
    Footer { background: $st-chrome; }
    """
    BINDINGS = [
        Binding("enter", "choose", "Start the shell here", priority=True),
        Binding("escape", "keep", "Keep the current environment", priority=True),
        Binding("ctrl+c", "keep", show=False, priority=True),
    ]

    def __init__(self, current: Environment, found: list[Environment], theme: str):
        super().__init__()
        tui_theme.apply(self, theme)
        self.choices = [current, *found]

    def compose(self) -> ComposeResult:
        with Horizontal(id="app-header"):
            yield Static("jupyterlab-device  device shell", id="hdr-title")
            yield Static(f"v{__version__}", id="hdr-version")
        yield Static("Start the device shell in which environment?", id="question")
        width = max(len(choice.name) for choice in self.choices)
        yield OptionList(*(_entry(choice, width) for choice in self.choices))
        yield Footer()

    def action_choose(self) -> None:
        self.exit(self.choices[self.query_one(OptionList).highlighted or 0])

    def action_keep(self) -> None:
        self.exit(self.choices[0])


def choose(current: Environment, found: list[Environment]) -> Environment:
    """Show the selector on the terminal and return the environment the user chose."""
    return EnvironmentPicker(current, found, tui_theme.pick_theme()).run() or current
