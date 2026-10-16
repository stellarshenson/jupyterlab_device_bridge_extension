"""The serial terminal of `jupyterlab-device terminal`: a full-screen Textual app for a person.

The app opens the virtual serial device with pyserial, as every serial tool does, so the
bridge shows it as the holder and runs the action on open of the device's profile. One
thread reads the port and one writes to it, in the order the user sent the bytes. The
serial settings, the control lines and the actions go through the REST API of the bridge
(`DeviceBridgeClient`): a pty refuses the DTR, RTS and parity calls of a tool.

Every call to the bridge runs in a thread, so the app never waits for the server on the
event loop. In the tests that loop also runs the server.
"""

import asyncio
import collections
import os
import queue
import threading
import time
from datetime import datetime

import serial
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.screen import ModalScreen
from textual.widgets import Input, RadioButton, RadioSet, RichLog, Static

from . import __version__, tui_theme
from .client import DeviceBridgeClient, DeviceBridgeError

# WSL leaves COLORTERM unset, and Textual then reduces the theme colours to 256 colours.
os.environ.setdefault("COLORTERM", "truecolor")

APP_NAME = "jupyterlab-device terminal"
# How often the app reads the device record of the bridge for the header and the state.
POLL_S = 0.5
# The longest wait of one read of the port, so that the reader sees the stop request.
READ_S = 0.05
# Bytes from the port become one line at a line feed, after a pause of READ_S, or at this length.
LINE_BYTES = 256
# Lines kept for the view; a switch between text and hex draws them again.
KEEP_LINES = 5000
# How long a break holds the line.
BREAK_S = 0.25
LINE_ENDINGS = {"none": b"", "LF": b"\n", "CR": b"\r", "CRLF": b"\r\n"}
DATA_BITS = (7, 8)
PARITIES = ("none", "even", "odd")
STOP_BITS = (1, 2)
SEND_AS = ("text", "hex")
MAX_BAUD = 4294967295

CSS = """
Screen { background: $st-screen; color: $st-text; }
#app-header { height: auto; background: $st-chrome; }
#hdr-title { width: 1fr; color: $st-cyan-bright; padding: 0 1; }
#hdr-version { width: auto; color: $st-muted; padding: 0 1; }
#traffic { height: 1fr; background: $st-screen; scrollbar-background: $st-screen;
           scrollbar-color: $st-border; }
#status-bar { height: 1; background: $st-chrome; }
#state { width: auto; padding: 0 1; color: $st-mint; }
#state.removed { color: $st-rose; }
#message { width: 1fr; color: $st-text; }
#message.error { color: $st-rose; }
#send-row { height: 3; background: $st-screen; }
#send-mode { width: auto; padding: 1 1; color: $st-muted; }
#send { width: 1fr; background: $st-surface; color: $st-text; border: tall $st-border; }
#send:focus { border: tall $st-cyan; }
#keys { height: auto; background: $st-chrome; color: $st-muted; padding: 0 1; }
SettingsScreen { align: center middle; }
#settings-box { width: 64; height: auto; background: $st-chrome; border: round $st-cyan;
                padding: 0 2; }
#settings-box .title { color: $st-cyan-bright; padding: 1 0 0 0; }
#settings-box .label { color: $st-muted; padding: 1 0 0 0; }
#settings-box Input { background: $st-surface; color: $st-text; border: tall $st-border; }
#settings-box Input:focus { border: tall $st-cyan; }
#settings-box RadioSet { layout: horizontal; width: 100%; background: $st-surface;
                         border: tall $st-border; }
#settings-box RadioSet:focus-within { border: tall $st-cyan; }
#settings-box RadioButton { background: $st-surface; color: $st-text; }
#settings-error { color: $st-rose; }
#settings-hint { color: $st-muted; padding: 1 0; }
"""


class Received(Message):
    """Bytes the port sent; one line of the view."""

    def __init__(self, data: bytes) -> None:
        super().__init__()
        self.data = data


class Sent(Message):
    """Bytes the writer passed to the port; one line of the view."""

    def __init__(self, data: bytes) -> None:
        super().__init__()
        self.data = data


class PortLost(Message):
    """A read or a write of the device path failed: the virtual device is gone."""

    def __init__(self, reason: str) -> None:
        super().__init__()
        self.reason = reason


def printable(data: bytes) -> str:
    """The bytes of one line as text: the line end removed, other control bytes as \\xNN."""
    text = data.removesuffix(b"\n").removesuffix(b"\r").decode("utf-8", "backslashreplace")
    return "".join(f"\\x{ord(c):02x}" if (c < " " and c != "\t") or c == "\x7f" else c for c in text)


def settings_text(settings: dict) -> str:
    """Serial settings in the short form, for example `115200 8N1`."""
    return (f"{settings['baudRate']} {settings['dataBits']}"
            f"{settings['parity'][0].upper()}{settings['stopBits']}")


class SettingsScreen(ModalScreen):
    """The serial settings of the port and the way a line is sent.

    Dismissed with `{baudRate, dataBits, parity, stopBits, ending, sendAs}`, or None on Esc.
    """

    BINDINGS = [
        Binding("enter", "apply", "apply", priority=True),
        Binding("escape", "cancel", "cancel"),
    ]

    def __init__(self, settings: dict, ending: str, send_as: str) -> None:
        super().__init__()
        self._settings = settings
        self._ending = ending
        self._send_as = send_as

    def compose(self) -> ComposeResult:
        def choices(widget_id: str, values: tuple, current: object) -> RadioSet:
            return RadioSet(*(RadioButton(str(value), value=value == current) for value in values),
                            id=widget_id)

        with Vertical(id="settings-box"):
            yield Static("Serial settings", classes="title")
            yield Static("Baud rate", classes="label")
            yield Input(str(self._settings["baudRate"]), id="baud", type="integer")
            yield Static("Data bits", classes="label")
            yield choices("data-bits", DATA_BITS, self._settings["dataBits"])
            yield Static("Parity", classes="label")
            yield choices("parity", PARITIES, self._settings["parity"])
            yield Static("Stop bits", classes="label")
            yield choices("stop-bits", STOP_BITS, self._settings["stopBits"])
            yield Static("Line ending of a sent line", classes="label")
            yield choices("ending", tuple(LINE_ENDINGS), self._ending)
            yield Static("Send the typed line as", classes="label")
            yield choices("send-as", SEND_AS, self._send_as)
            yield Static("", id="settings-error")
            yield Static("Tab/arrows move, Space chooses, Enter applies, Esc cancels",
                         id="settings-hint")

    def _chosen(self, widget_id: str, values: tuple) -> object:
        return values[self.query_one(f"#{widget_id}", RadioSet).pressed_index]

    def action_apply(self) -> None:
        text = self.query_one("#baud", Input).value
        if not text.isdigit() or not 1 <= int(text) <= MAX_BAUD:
            self.query_one("#settings-error", Static).update(
                f"refused: the baud rate is a whole number from 1 to {MAX_BAUD}")
            return
        self.dismiss({
            "baudRate": int(text),
            "dataBits": self._chosen("data-bits", DATA_BITS),
            "parity": self._chosen("parity", PARITIES),
            "stopBits": self._chosen("stop-bits", STOP_BITS),
            "ending": self._chosen("ending", tuple(LINE_ENDINGS)),
            "sendAs": self._chosen("send-as", SEND_AS),
        })

    def action_cancel(self) -> None:
        self.dismiss(None)


class SerialTerminal(App):
    """The terminal on one serial device of the bridge.

    Args:
        bridge: The client of the bridge.
        record: The serial record of the device when the terminal starts.
        baud: The baud rate the app opens the device path with.
        theme: `stellars-tech-dark` or `stellars-tech-light`, see `tui_theme.pick_theme`.
    """

    CSS = CSS
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [
        Binding("ctrl+q", "quit", "quit", key_display="^q", priority=True),
        Binding("escape", "quit", "quit", key_display="esc"),
        Binding("ctrl+o", "settings", "settings", key_display="^o", priority=True),
        Binding("ctrl+x", "hex_view", "text/hex", key_display="^x", priority=True),
        Binding("ctrl+p", "pause", "pause", key_display="^p", priority=True),
        Binding("ctrl+l", "clear", "clear", key_display="^l", priority=True),
        # The board actions are on function keys: the send field keeps its editing keys
        # (Ctrl+A, E, D, U, K), and F1, F5, F9, F11 and F12 are taken by the browser or the lab.
        Binding("f2", "line('dtr')", "DTR on/off", key_display="F2", priority=True),
        Binding("f3", "line('rts')", "RTS on/off", key_display="F3", priority=True),
        Binding("f4", "brk", "break", key_display="F4", priority=True),
        Binding("f6", "run('pulse-dtr')", "pulse DTR", key_display="F6", priority=True),
        Binding("f7", "run('pulse-rts')", "pulse RTS", key_display="F7", priority=True),
        Binding("f8", "run('esp-bootloader')", "ESP bootloader", key_display="F8", priority=True),
        Binding("f10", "run('touch-1200')", "1200 baud touch", key_display="F10", priority=True),
        # Ctrl+C does not quit: it goes to the board, which may run a program it interrupts.
        Binding("ctrl+c", "interrupt", "send 0x03", key_display="^c", priority=True),
    ]

    def __init__(self, bridge: DeviceBridgeClient, record: dict, baud: int, theme: str) -> None:
        super().__init__()
        tui_theme.apply(self, theme)
        self.device_name = record["name"]
        self.path = record["path"]
        self.baud = baud
        self._device = bridge.serial(self.device_name)
        self._record = record
        self._port: serial.Serial | None = None
        self._lost: str | None = None  # why the device path failed
        self._stop = threading.Event()
        self._outbox: queue.Queue = queue.Queue()
        self._threads: list[threading.Thread] = []
        self._entries: collections.deque = collections.deque(maxlen=KEEP_LINES)
        self._rx = 0
        self._tx = 0
        self._hex_view = False
        self._paused = False
        self._ending = "LF"
        self._send_as = "text"

    # ------------------------------------------------------------------ layout

    def compose(self) -> ComposeResult:
        with Horizontal(id="app-header"):
            yield Static(id="hdr-title", markup=False)
            yield Static(f"v{__version__}", id="hdr-version", markup=False)
        traffic = RichLog(id="traffic", wrap=True, max_lines=KEEP_LINES)
        # The send field keeps the focus: a click on the view does not take it, so the
        # keys a person types after a click in the terminal still go to the send field.
        traffic.can_focus = False
        yield traffic
        with Horizontal(id="status-bar"):
            yield Static(id="state", markup=False)
            yield Static(id="message", markup=False)
        with Horizontal(id="send-row"):
            yield Static(id="send-mode", markup=False)
            yield Input(id="send", placeholder="type a line; Enter sends it")
        yield Static(self._keys_text(), id="keys", markup=False)

    def _keys_text(self) -> str:
        return "  ".join(f"{b.key_display} {b.description}" for b in self.BINDINGS)

    def on_mount(self) -> None:
        try:
            self._port = serial.Serial(self.path, self.baud, timeout=READ_S)
        except (serial.SerialException, OSError) as error:
            self.exit(return_code=1, message=f"jupyterlab-device: cannot open {self.path}: {error}")
            return
        self._threads = [threading.Thread(target=target, daemon=True)
                         for target in (self._read_port, self._write_port)]
        for thread in self._threads:
            thread.start()
        self._show_send_mode()
        self._show()
        self.set_interval(POLL_S, self._poll)
        self.query_one("#send", Input).focus()

    def on_unmount(self) -> None:
        self._stop.set()
        self._outbox.put(None)
        for thread in self._threads:
            thread.join(1)
        if self._port is not None:
            self._port.close()

    # ------------------------------------------------------- port threads

    def _read_port(self) -> None:
        pending = b""
        while not self._stop.is_set():
            try:
                data = self._port.read(self._port.in_waiting or 1)
            except (serial.SerialException, OSError) as error:
                if not self._stop.is_set():
                    self.post_message(PortLost(str(error)))
                return
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                self.post_message(Received(line + b"\n"))
            if pending and (not data or len(pending) >= LINE_BYTES):
                self.post_message(Received(pending))
                pending = b""

    def _write_port(self) -> None:
        while (data := self._outbox.get()) is not None:
            try:
                self._port.write(data)
            except (serial.SerialException, OSError) as error:
                self.post_message(PortLost(str(error)))
                return
            self.post_message(Sent(data))

    def on_received(self, message: Received) -> None:
        self._rx += len(message.data)
        self._add("RX", message.data)

    def on_sent(self, message: Sent) -> None:
        self._tx += len(message.data)
        self._add("TX", message.data)

    def on_port_lost(self, message: PortLost) -> None:
        self._lost = message.reason
        self._show()

    # ------------------------------------------------------------- the view

    def _add(self, direction: str, data: bytes) -> None:
        entry = (datetime.now().strftime("%H:%M:%S.%f")[:-3], direction, data)
        self._entries.append(entry)
        self.query_one("#traffic", RichLog).write(self._line(*entry))
        self._show()

    def _line(self, stamp: str, direction: str, data: bytes) -> Text:
        body = data.hex(" ") if self._hex_view else printable(data)
        role = "amber" if direction == "RX" else "cyan"
        return Text(f"{stamp} {direction} {body}", style=tui_theme.color(self, role))

    def _redraw(self) -> None:
        log = self.query_one("#traffic", RichLog)
        log.clear()
        for entry in self._entries:
            log.write(self._line(*entry))

    def _attached(self) -> bool:
        return self._lost is None and self._record.get("state") == "attached"

    def _show(self) -> None:
        """Draw the header and the state from the last record and the counters."""
        settings, signals = self._record["settings"], self._record["signals"]

        def line(key: str) -> str:
            return {True: "on", False: "off"}.get(signals.get(key), "-")

        self.query_one("#hdr-title", Static).update(
            f"{APP_NAME} · {self.device_name} {self.path} · {settings_text(settings)} · "
            f"DTR {line('dtr')} RTS {line('rts')} · RX {self._rx} TX {self._tx}")
        state = self.query_one("#state", Static)
        if self._attached():
            state.update("attached")
        elif self._lost is not None:
            state.update(f"removed - the device path failed: {self._lost}")
        elif self._record.get("error") == "removed":
            state.update("removed - the browser no longer lists the port")
        else:
            state.update("removed - no lab tab holds the port")
        state.set_class(not self._attached(), "removed")

    def _show_send_mode(self) -> None:
        mode = "hex" if self._send_as == "hex" else f"text {self._ending}"
        self.query_one("#send-mode", Static).update(f"send {mode} >")

    def _say(self, text: str, error: bool = False) -> None:
        message = self.query_one("#message", Static)
        message.update(text)
        message.set_class(error, "error")

    # ------------------------------------------------------------- the bridge

    def _poll(self) -> None:
        self.run_worker(self._refresh(), group="poll", exclusive=True)

    async def _refresh(self) -> None:
        try:
            self._record = await asyncio.to_thread(self._device.record)
        except DeviceBridgeError as error:
            if error.code == "unknown-device":
                self._record = {**self._record, "state": "detached", "error": "removed"}
            else:
                self._say(f"no answer from the bridge: {error}", error=True)
        self._show()

    @work(group="calls")
    async def _call(self, done: str, function, *args, **kwargs) -> None:
        """Run one call of the bridge in a thread and name its outcome in the status line."""
        try:
            await asyncio.to_thread(function, *args, **kwargs)
        except (DeviceBridgeError, serial.SerialException, OSError) as error:
            self._say(f"refused: {error}", error=True)
        else:
            self._say(done)
        await self._refresh()

    # ---------------------------------------------------------------- sending

    def _send(self, data: bytes) -> None:
        if not self._attached():
            self._say("removed: nothing was sent", error=True)
            return
        if data:
            self._outbox.put(data)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "send":
            return
        if self._send_as == "hex":
            try:
                data = bytes.fromhex(event.value)
            except ValueError:
                self._say(f"refused: {event.value!r} is not bytes written as hex digits, "
                          "for example 7f 00 a5; nothing was sent", error=True)
                return
        else:
            data = event.value.encode() + LINE_ENDINGS[self._ending]
        event.input.clear()
        self._send(data)

    # ---------------------------------------------------------------- actions

    def check_action(self, action: str, parameters: tuple) -> bool:
        # On the settings screen only quit and the focus keys (Tab, Shift+Tab) act; the
        # other keys belong to its fields.
        return action in ("quit", "focus_next", "focus_previous") or not isinstance(self.screen, SettingsScreen)

    def action_settings(self) -> None:
        self.push_screen(SettingsScreen(self._record["settings"], self._ending, self._send_as),
                         self._apply)

    def _apply(self, choice: dict | None) -> None:
        if choice is None:
            return
        self._ending, self._send_as = choice.pop("ending"), choice.pop("sendAs")
        self._show_send_mode()
        change = {field: value for field, value in choice.items()
                  if value != self._record["settings"][field]}
        if change:
            self._call(f"settings {settings_text(choice)} applied", self._set_settings, change)

    def _set_settings(self, change: dict) -> None:
        # While a tool holds the device the baud rate of the port is the tool's own, so the
        # app sets it on the path; the frame format is the profile's (docs/design.md).
        if "baudRate" in change:
            self._port.baudrate = change["baudRate"]
        self._device.set_profile(**change)

    def action_hex_view(self) -> None:
        self._hex_view = not self._hex_view
        self._redraw()
        self._say(f"display: {'hex' if self._hex_view else 'text'}")

    def action_pause(self) -> None:
        self._paused = not self._paused
        self.query_one("#traffic", RichLog).auto_scroll = not self._paused
        self._say("scrolling paused; ^p resumes" if self._paused else "scrolling resumed")

    def action_clear(self) -> None:
        self._entries.clear()
        self.query_one("#traffic", RichLog).clear()
        self._say("view cleared")

    def action_line(self, line: str) -> None:
        # A line without a reported state is taken as on, so the first press turns it off.
        value = not self._record["signals"].get(line, True)
        self._call(f"{line.upper()} {'on' if value else 'off'}", self._device.signals, **{line: value})

    def action_brk(self) -> None:
        self._call("break sent", self._break)

    def _break(self) -> None:
        self._device.signals(brk=True)
        time.sleep(BREAK_S)
        self._device.signals(brk=False)

    def action_run(self, action: str) -> None:
        self._call(f"{action} done", self._device.action, action)

    def action_interrupt(self) -> None:
        self._send(b"\x03")
