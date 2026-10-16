"""Tests of the serial terminal app (`terminal_app.py`) on a real virtual serial device.

The app runs headless with Textual's `run_test` in this process, on the event loop that
also runs the test server and the browser tab double. The app opens the pty of the
bridge with pyserial and makes every call of the bridge in a thread. The command
`jupyterlab-device terminal` that starts it is tested in `test_cli.py`.
"""

import asyncio
import contextlib
import os
import pty
import re
import select
import subprocess
import sys
import tomllib

import pytest
from textual.widgets import Input, RadioButton, RadioSet, RichLog, Static

from jupyterlab_device_bridge_extension import __version__, tui_theme
from jupyterlab_device_bridge_extension.client import DeviceBridgeClient
from jupyterlab_device_bridge_extension.terminal_app import SerialTerminal, SettingsScreen
from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_NAME

from .test_client import REPOSITORY, attach_serial
from .test_manager import record

SIZE = (140, 40)
DARK = "stellars-tech-dark"
LINE = re.compile(r"^\d\d:\d\d:\d\d\.\d{3} (RX|TX) (.*)$")


@pytest.fixture
def terminal(fake_tab, bridge_address):
    """Factory of the app on the attached serial port: `tab, app = await terminal()`."""
    async def start(theme=DARK):
        tab, _ = await attach_serial(fake_tab)
        tab.echo = False
        bridge = DeviceBridgeClient(*bridge_address, program="jupyterlab-device")
        start_record = await asyncio.to_thread(bridge.serial(SERIAL_NAME).record)
        return tab, SerialTerminal(bridge, start_record, start_record["settings"]["baudRate"], theme)

    return start


def text_of(app, selector):
    return str(app.query_one(selector, Static).render())


def view(app):
    """The lines of the traffic view as `(direction, body, colour)`; a line the log wrapped counts once."""
    lines = []
    for strip in app.query_one("#traffic", RichLog).lines:
        text = strip.text.rstrip()
        match = LINE.match(text)
        colours = {segment.style.color.triplet.hex for segment in strip if segment.text.strip()}
        if match:
            lines.append((match[1], match[2], colours))
        elif lines and text:
            direction, body, before = lines[-1]
            lines[-1] = (direction, f"{body} {text.strip()}", before | colours)
    return lines


def rx(app, separator):
    """The bodies of the RX lines joined: the pty may hand one message over in more than one read."""
    return separator.join(body for direction, body, _ in view(app) if direction == "RX")


async def held(tab, app):
    """Wait until the bridge shows this process as the holder and the app shows the port."""
    await tab.until(lambda: (record(tab)["holder"] or {}).get("pid") == os.getpid())
    await tab.until(lambda: text_of(app, "#state") == "attached")


async def type_line(pilot, text):
    pilot.app.query_one("#send", Input).value = text
    await pilot.press("enter")


async def choose(pilot, **choices):
    """Open the settings screen, choose values and apply them with Enter."""
    await pilot.press("ctrl+o")
    await pilot.pause()
    screen = pilot.app.screen
    assert isinstance(screen, SettingsScreen)
    for widget_id, label in choices.items():
        if widget_id == "baud":
            screen.query_one("#baud", Input).value = label
            continue
        button = next(button for button in screen.query_one(f"#{widget_id}", RadioSet).query(RadioButton)
                      if str(button.label) == label)
        button.value = True
    await pilot.pause()
    await pilot.press("enter")
    await pilot.pause()


def colours_of(svg, text):
    """The fill colours of the text elements of a screenshot that hold `text`."""
    fills = dict(re.findall(r"\.(\S+) \{ fill: (#[0-9a-f]{6})", svg))
    return {fills.get(cls) for cls, body in re.findall(r'<text class="(\S+)"[^>]*>([^<]*)</text>', svg)
            if text in body.replace("&#160;", " ")}


# ---------------------------------------------------------------------------- the app


async def test_acc_term_165_the_app_opens_the_device_path_with_pyserial_and_holds_it(terminal):
    """ACC-TERM-165 the Textual app opens the path of the virtual device as a serial tool: the bridge shows this process as the holder; textual is a dependency of the wheel."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        assert app._port.port == record(tab)["path"]
        await tab.port_sends(SERIAL_NAME, b"boot\n")
        await tab.until(lambda: view(app))
        assert view(app)[0][:2] == ("RX", "boot")
        await pilot.press("ctrl+q")
    with open(REPOSITORY / "pyproject.toml", "rb") as file:
        dependencies = tomllib.load(file)["project"]["dependencies"]
    assert any(dependency.startswith("textual>=") for dependency in dependencies)
    assert any(dependency.startswith("pyserial>=") for dependency in dependencies)


async def test_acc_term_166_the_view_lists_both_directions_with_time_and_switches_to_hex(terminal):
    """ACC-TERM-166 bytes from the port show as an RX line in amber, a sent line as a TX line in cyan, each with the time; ^x shows 41 42 43 for ABC; ^p pauses scrolling and ^l clears the view."""
    tab, app = await terminal()
    amber, cyan = tui_theme.PALETTES["dark"]["amber"], tui_theme.PALETTES["dark"]["cyan"]
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await tab.port_sends(SERIAL_NAME, b"hello from the board\r\n")
        await tab.until(lambda: rx(app, "") == "hello from the board")
        await type_line(pilot, "abc")
        await tab.until(lambda: ("TX", "abc", {cyan}) in view(app))
        assert all(colours == {amber} for direction, _, colours in view(app) if direction == "RX")

        await pilot.press("ctrl+x")
        await tab.port_sends(SERIAL_NAME, b"ABC")
        await tab.until(lambda: rx(app, " ").endswith("41 42 43"))
        assert rx(app, " ") == "68 65 6c 6c 6f 20 66 72 6f 6d 20 74 68 65 20 62 6f 61 72 64 0d 0a 41 42 43"
        assert ("TX", "61 62 63 0a") in [(direction, body) for direction, body, _ in view(app)]
        await pilot.press("ctrl+x")
        assert rx(app, "") == "hello from the boardABC"

        log = app.query_one("#traffic", RichLog)
        await pilot.press("ctrl+p")
        assert log.auto_scroll is False
        await pilot.press("ctrl+p")
        assert log.auto_scroll is True
        await pilot.press("ctrl+l")
        assert view(app) == [] and log.lines == []
        await pilot.press("ctrl+q")


async def test_acc_term_167_the_header_shows_the_device_its_settings_lines_counts_and_version(terminal):
    """ACC-TERM-167 the header shows name, path, settings, DTR, RTS, RX and TX counts and the version, and each value follows a change: baud 9600 and DTR off."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        path = record(tab)["path"]
        assert text_of(app, "#hdr-title") == (
            f"jupyterlab-device terminal · {SERIAL_NAME} {path} · 115200 8N1 · DTR - RTS - · RX 0 TX 0")
        assert text_of(app, "#hdr-version") == f"v{__version__}"

        await choose(pilot, baud="9600")
        await pilot.press("f2")
        await tab.port_sends(SERIAL_NAME, b"12345\n")
        await type_line(pilot, "ab")
        await tab.until(lambda: " · 9600 8N1 · DTR off RTS - · RX 6 TX 3" in text_of(app, "#hdr-title"))
        await pilot.press("ctrl+q")


async def test_acc_term_168_the_settings_screen_reopens_the_port_with_the_new_settings(terminal):
    """ACC-TERM-168 9600 8E1 chosen in the settings screen reopens the port at 9600 8E1 while the app runs, and the device record lists them; a refused baud rate changes nothing."""
    tab, app = await terminal()
    wanted = {"baudRate": 9600, "dataBits": 8, "parity": "even", "stopBits": 1}
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await pilot.press("ctrl+o")
        await pilot.pause()
        app.screen.query_one("#baud", Input).value = "0"
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, SettingsScreen), "a refused baud rate keeps the screen open"
        assert "refused: the baud rate is a whole number" in text_of(app.screen, "#settings-error")
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, SettingsScreen) and app.is_running

        await choose(pilot, baud="9600", parity="even")
        await tab.until(lambda: tab.settings[SERIAL_NAME] == wanted)
        await tab.until(lambda: record(tab)["settings"] == wanted)
        assert tab.got("serial-configure")[-1]["settings"] == wanted
        assert record(tab)["holder"]["pid"] == os.getpid(), "the app did not restart"
        await tab.until(lambda: "settings 9600 8E1 applied" == text_of(app, "#message"))
        await pilot.press("ctrl+q")


async def test_acc_term_168_the_settings_screen_works_from_the_keyboard_alone(terminal):
    """ACC-TERM-168 on the settings screen Tab moves from the baud rate to data bits and parity, Right and Space choose even, and Enter applies it to the port."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await pilot.press("ctrl+o")
        await pilot.pause()
        await pilot.press("tab")
        assert app.focused.id == "data-bits"
        await pilot.press("tab")
        assert app.focused.id == "parity"
        await pilot.press("right", "space", "enter")
        await tab.until(lambda: record(tab)["settings"]["parity"] == "even")
        assert not isinstance(app.screen, SettingsScreen)
        await pilot.press("ctrl+q")


async def test_acc_term_169_keys_set_the_control_lines_send_a_break_and_run_the_actions(terminal):
    """ACC-TERM-169 F2 and F3 set DTR and RTS off and on, F4 sends a break, F6 F7 F8 F10 run the four actions, and the footer lists every key."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)

        def signals():
            return [{line: event[line] for line in ("dtr", "rts", "brk") if line in event}
                    for event in tab.got("serial-signals")]

        await pilot.press("f2")
        await tab.until(lambda: signals() == [{"dtr": False}])
        await tab.until(lambda: "DTR off" in text_of(app, "#hdr-title"))
        await pilot.press("f2")
        await tab.until(lambda: signals()[1:] == [{"dtr": True}])
        await tab.until(lambda: "DTR on" in text_of(app, "#hdr-title"))
        await pilot.press("f3")
        await tab.until(lambda: signals()[2:] == [{"rts": False}])
        await tab.until(lambda: "RTS off" in text_of(app, "#hdr-title"))
        await pilot.press("f4")
        await tab.until(lambda: signals()[3:] == [{"brk": True}, {"brk": False}])

        for key, action in (("f6", "pulse-dtr"), ("f7", "pulse-rts"),
                            ("f8", "esp-bootloader"), ("f10", "touch-1200")):
            await pilot.press(key)
            await tab.until(lambda: tab.got("serial-action")
                            and tab.got("serial-action")[-1]["action"] == action)
            await tab.until(lambda: text_of(app, "#message") == f"{action} done")

        keys = text_of(app, "#keys")
        for label in ("^q quit", "esc quit", "^o settings", "^x text/hex", "^p pause", "^l clear",
                      "F2 DTR on/off", "F3 RTS on/off", "F4 break", "F6 pulse DTR", "F7 pulse RTS",
                      "F8 ESP bootloader", "F10 1200 baud touch", "^c send 0x03"):
            assert label in keys
        await pilot.press("ctrl+q")


@pytest.mark.parametrize(("ending", "sent"), [("none", b"abc"), ("LF", b"abc\n"), ("CR", b"abc\r"),
                                              ("CRLF", b"abc\r\n")])
async def test_acc_term_170_enter_sends_the_line_with_the_chosen_line_ending(terminal, ending, sent):
    """ACC-TERM-170 abc and Enter reach the port through the pty with the line ending chosen in the settings screen."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await choose(pilot, ending=ending)
        assert text_of(app, "#send-mode") == f"send text {ending} >"
        await type_line(pilot, "abc")
        await tab.until(lambda: tab.written(SERIAL_NAME) == sent)
        assert app.query_one("#send", Input).value == ""
        await pilot.press("ctrl+q")


async def test_acc_term_75_a_click_on_the_traffic_view_keeps_the_focus_on_the_send_field(terminal):
    """ACC-TERM-75 after a click on the traffic view the typed keys a, b, c and Enter still reach the port as abc and a line feed."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await pilot.click("#traffic")
        await pilot.press("a", "b", "c", "enter")
        await tab.until(lambda: tab.written(SERIAL_NAME) == b"abc\n")
        assert app.focused is app.query_one("#send", Input)
        await pilot.press("ctrl+q")


async def test_acc_term_170_hex_mode_sends_hex_digits_and_refuses_other_input(terminal):
    """ACC-TERM-170 in hex mode 41 4G is refused, named in the status line in rose and sends nothing; 41 42 sends AB without a line ending."""
    tab, app = await terminal()
    rose = tui_theme.PALETTES["dark"]["rose"]
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await choose(pilot, **{"send-as": "hex"})
        assert text_of(app, "#send-mode") == "send hex >"
        await type_line(pilot, "41 4G")
        await pilot.pause()
        assert "refused: '41 4G' is not bytes written as hex digits" in text_of(app, "#message")
        assert app.query_one("#message", Static).has_class("error")
        assert rose in colours_of(app.export_screenshot(), "refused:")
        assert app.query_one("#send", Input).value == "41 4G", "the refused input stays to be corrected"

        await type_line(pilot, "41 42")
        await tab.until(lambda: tab.written(SERIAL_NAME) == b"AB")
        await asyncio.sleep(0.3)
        assert tab.written(SERIAL_NAME) == b"AB", "41 4G sent nothing"
        await pilot.press("ctrl+q")


@pytest.mark.parametrize("mode", ["dark", "light"])
async def test_acc_term_171_the_theme_from_textual_theme_colours_rx_amber_and_tx_cyan(terminal, monkeypatch, mode):
    """ACC-TERM-171 with TEXTUAL_THEME naming a brand theme the app starts in it, and the screenshot shows the RX line in its amber and the TX line in its cyan."""
    monkeypatch.setenv("TEXTUAL_THEME", f"stellars-tech-{mode}")
    tab, app = await terminal(tui_theme.pick_theme())
    palette = tui_theme.PALETTES[mode]
    async with app.run_test(size=SIZE) as pilot:
        assert app.theme == f"stellars-tech-{mode}"
        await held(tab, app)
        await tab.port_sends(SERIAL_NAME, b"from the port\n")
        await tab.until(lambda: len(view(app)) == 1)
        await type_line(pilot, "to the port")
        await tab.until(lambda: len(view(app)) == 2)
        await pilot.pause()
        svg = app.export_screenshot()
        assert colours_of(svg, "RX from the port") == {palette["amber"]}
        assert colours_of(svg, "TX to the port") == {palette["cyan"]}
        assert colours_of(svg, "settings") == {palette["muted"]}
        await pilot.press("ctrl+q")


# The theme choice of `terminal` in a process whose controlling terminal is its standard input.
PICK_THEME = ("import fcntl, termios; fcntl.ioctl(0, termios.TIOCSCTTY, 0); "
              "from jupyterlab_device_bridge_extension import tui_theme; print(tui_theme.pick_theme())")


@pytest.mark.parametrize(("background", "theme"), [("0000/0000/0000", "stellars-tech-dark"),
                                                   ("ffff/ffff/ffff", "stellars-tech-light")])
def test_acc_term_171_without_textual_theme_the_theme_follows_the_background_that_the_terminal_reports(
        background, theme):
    """ACC-TERM-171 with neither TEXTUAL_THEME nor COLORFGBG set, the theme is picked from the terminal background: the terminal answers the OSC 11 question with black and the dark theme is chosen, with white and the light theme is chosen."""
    environment = {name: value for name, value in os.environ.items() if name not in ("TEXTUAL_THEME", "COLORFGBG")}
    environment["PYTHONPATH"] = str(REPOSITORY)
    keyboard, terminal = pty.openpty()
    child = subprocess.Popen([sys.executable, "-c", PICK_THEME], stdin=terminal, stdout=subprocess.PIPE,
                             env=environment, start_new_session=True)
    os.close(terminal)
    question = b""
    with contextlib.suppress(OSError):  # the terminal is closed when the child ended without asking
        while b"\x1b[c" not in question and select.select([keyboard], [], [], 10)[0]:
            question += os.read(keyboard, 64)
    assert question.startswith(b"\x1b]11;?"), "the terminal was not asked for its background"
    os.write(keyboard, f"\x1b]11;rgb:{background}\x1b\\\x1b[?62c".encode())

    out, _ = child.communicate(timeout=10)
    os.close(keyboard)
    assert out.decode().strip() == theme


@pytest.mark.parametrize("key", ["ctrl+q", "escape"])
async def test_acc_term_172_quit_closes_the_device_path_and_the_record_has_no_holder(terminal, key):
    """ACC-TERM-172 Ctrl+Q and Esc end the app and close the device path: the record of the device then has no holder. Ctrl+C does not quit, it sends 0x03."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await pilot.press("ctrl+c")
        await tab.until(lambda: tab.written(SERIAL_NAME) == b"\x03")
        assert app.is_running
        await pilot.press(key)
        await pilot.pause()
        assert not app.is_running
    assert app.return_code == 0
    await tab.until(lambda: record(tab)["holder"] is None)


@pytest.mark.parametrize("reason", ["removed", "detach"])
async def test_acc_term_173_a_removed_port_leaves_the_app_open_with_removed_in_rose(terminal, reason):
    """ACC-TERM-173 when the tab releases the port the app stays open, the status line reads removed in rose, and a typed line is not sent."""
    tab, app = await terminal()
    rose = tui_theme.PALETTES["dark"]["rose"]
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await tab.release(SERIAL_NAME, reason)
        await tab.until(lambda: text_of(app, "#state").startswith("removed"))
        assert app.query_one("#state", Static).has_class("removed")
        assert colours_of(app.export_screenshot(), "removed") == {rose}
        await type_line(pilot, "abc")
        await pilot.pause()
        assert text_of(app, "#message") == "removed: nothing was sent"
        await asyncio.sleep(0.3)
        assert tab.written(SERIAL_NAME) == b""
        assert app.is_running and app.return_code is None
        await pilot.press("ctrl+q")
    assert app.return_code == 0


async def test_acc_term_173_a_forgotten_port_whose_pty_is_gone_leaves_the_app_open(terminal):
    """ACC-TERM-173 when the port is forgotten the bridge removes the pty: the read fails, the app stays open, reads removed and raises nothing."""
    tab, app = await terminal()
    async with app.run_test(size=SIZE) as pilot:
        await held(tab, app)
        await tab.release(SERIAL_NAME, "forget")
        await tab.until(lambda: text_of(app, "#state").startswith("removed"))
        await tab.until(lambda: "the device path failed" in text_of(app, "#state"))
        await pilot.press("f2")
        await tab.until(lambda: text_of(app, "#message").startswith("refused: "))
        assert app.is_running and app.return_code is None
        await pilot.press("ctrl+q")
    assert app.return_code == 0
