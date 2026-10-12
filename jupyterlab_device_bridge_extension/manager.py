"""The device manager: which tab owns which device, and what programs ask of a device.

One `DeviceManager` lives in the Jupyter server. Lab tabs talk to it over the
WebSocket (`connect`, `receive`, `port_data`, `disconnect`); the REST handlers call
the rest. Serial devices keep their virtual serial device, monitor buffer and name
while no tab holds them.
"""

import asyncio
import base64
import contextlib
import functools
import itertools
import logging
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass

from tornado.web import HTTPError

from . import profiles, usb
from .monitor import MonitorBuffer
from .shim import ShimSocket
from .usb import UsbDevice
from .vserial import VirtualSerial, ensure_dir, lock_dir, remove_left

NAME_RE = re.compile(r"[a-z0-9-]{1,64}")
KINDS = ("serial", "usb")
# What a tab claims: s:<vid>:<pid>:<n> or s:port:<n>, and u:<vid>:<pid>:<serial number or #n>.
_KEY_RES = {
    "serial": re.compile(r"s:(?:(?P<vendor>[0-9a-f]{4}):(?P<product>[0-9a-f]{4})|port):\d{1,5}"),
    "usb": re.compile(r"u:(?P<vendor>[0-9a-f]{4}):(?P<product>[0-9a-f]{4}):.{1,255}"),
}
_NAME_PREFIXES = {"serial": "tty", "usb": "usb"}
DATA_FRAME = 0x01
COMMAND_TIMEOUT_S = 5.0
REQUEST_TTL_S = 300.0
PORT_STATES = ("closed", "opening", "open", "error")
SIGNALS = ("dtr", "rts", "brk")


def _text(value: object) -> str | None:
    """A text a tab sent, or None when it sent none."""
    return value if isinstance(value, str) else None


class BridgeError(HTTPError):
    """A request the bridge does not carry out.

    The REST API answers it as `{error: {code, message, name?}}` with `status`.

    Attributes:
        code: Short identifier of the case, for example `unknown-device`.
        message: The reason. For status 502 it is the browser's own message.
        name: The browser's error name for status 502, else None.
    """

    def __init__(self, status: int, code: str, message: str, name: str | None = None) -> None:
        super().__init__(status, message)
        self.code = code
        self.message = message
        self.name = name


@dataclass
class Tab:
    """One connected lab tab.

    Attributes:
        tab_id: The id the tab's worker made.
        serial: The browser has Web Serial.
        usb: The browser has WebUSB.
        send: Sends one message to the tab: a dict as a text frame, bytes as a binary frame.
        round_trip: Server to browser and back in ms; None until it is measured.
    """

    tab_id: str
    serial: bool
    usb: bool
    send: Callable[[dict | bytes], None]
    round_trip: float | None = None


class SerialDevice:
    """One serial port with its virtual serial device, shim socket and monitor buffer.

    The settings of the port are the profile's with the device's overrides. While a
    tool holds the virtual device the baud rate is the tool's, and the frame format
    is the tool's own when the shim reported it.
    """

    def __init__(self, manager: "DeviceManager", name: str, sid: int,
                 vendor_id: int | None, product_id: int | None, overrides: dict) -> None:
        self.manager = manager
        self.name = name
        self.sid = sid
        self.vendor_id = vendor_id
        self.product_id = product_id
        self.tab: str | None = None
        self.profile = profiles.DEFAULT_PROFILE
        self.overrides = overrides
        self.holder: dict | None = None
        self.port_state = "closed"
        self.signals: dict = {}
        self.rx = 0
        self.tx = 0
        self.error: str | None = None
        self._tool_baud = 0
        self._tool_frame: dict = {}
        self._shim_restart: asyncio.Future | None = None  # held so that the task is not collected
        self.path = os.path.join(manager.device_dir, name)
        self.pty = VirtualSerial(self.path, self._profile()["baudRate"], self)
        self.shim = self._shim_socket()
        self.monitor = MonitorBuffer(manager.monitor_bytes)
        self.settings = self._target()  # what the port was last asked to be open with

    def attach(self, tab_id: str) -> None:
        """A tab holds the port now."""
        self.tab = tab_id
        self.error = None

    def detach(self, error: str | None = None) -> None:
        """No tab holds the port any more; `error` says why when it was not the user."""
        self.tab = None
        self.port_state = "closed"
        self.signals = {}
        self.error = error

    def grant(self) -> dict:
        """The fields of the `claimed` answer for this device."""
        return {"name": self.name, "sid": self.sid, "settings": self.settings,
                "profile": self.profile}

    def set_profile(self, change: dict) -> None:
        """Apply a validated profile change: a profile id replaces the overrides, a field adds one."""
        change = dict(change)
        if "profile" in change:
            self.profile = change.pop("profile")
            self.overrides = {}
        self.overrides.update(change)
        self.pty.set_baud(self._profile()["baudRate"])
        self._configure()

    def port_reported(self, message: dict) -> None:
        """Take the tab's `serial-state`."""
        if message["state"] not in PORT_STATES:
            raise ValueError(f"unknown port state {message['state']!r}")
        self.port_state = message["state"]
        signals = message.get("signals") or {}
        self.signals = {line: bool(signals[line]) for line in SIGNALS if line in signals}
        self.error = _text(message.get("error"))

    def port_data(self, data: bytes) -> None:
        """Bytes the port sent: always to the monitor buffer, to the tool while one holds the device."""
        self.monitor.append(data)
        self.pty.write(data)

    async def start_shim(self) -> None:
        """Start the shim socket of the device's pty; its directory is checked like the device directory."""
        try:
            ensure_dir(self.manager.shim_dir)
            await self.shim.start()
        except OSError as error:
            # The port works with its profile alone; only `jupyterlab-device run` needs the socket.
            self.manager.log.error("device-bridge: no shim socket for %s: %s", self.name, error)

    def close(self) -> None:
        """Remove the virtual serial device and the shim socket."""
        self.pty.close()
        self.shim.close()

    def record(self) -> dict:
        """The serial record of docs/design.md."""
        return {
            "name": self.name, "path": self.path, "state": "attached" if self.tab else "detached",
            "portState": self.port_state, "tab": self.tab, "holder": self.holder,
            "settings": self.settings, "profile": self.profile, "overrides": self.overrides,
            "signals": self.signals, "rx": self.rx, "tx": self.tx,
            "vendorId": self.vendor_id, "productId": self.product_id, "error": self.error,
        }

    # ------------------------------------------------- the tool on the virtual device

    def tool_opened(self, holder: dict | None, baud: int) -> None:
        """A tool opened the device: the profile's settings at the tool's baud, then the action."""
        self.holder = holder
        self._tool_baud = baud
        self._configure()
        action = self._profile()["onOpen"]
        if action != "none" and self.tab:
            self.manager.post(self, {"type": "serial-action", "action": action})
        self.manager.devices_changed()

    def tool_baud(self, baud: int) -> None:
        """The tool set another baud rate."""
        self._tool_baud = baud
        self._configure()
        self.manager.devices_changed()

    def tool_data(self, chunk: bytes) -> None:
        """Bytes the tool wrote: to the port, or nowhere while the device is detached."""
        self.manager.send_data(self, chunk)

    def tool_closed(self) -> None:
        """The tool closed the device: back to the profile's own settings."""
        self.holder = None
        self._tool_frame = {}
        self._configure()
        self.manager.devices_changed()
        if self.shim.minor != self.pty.minor:
            # The device took a new pty; the shim looks for the socket of that pty.
            self.shim.close()
            self.shim = self._shim_socket()
            self._shim_restart = asyncio.ensure_future(self.start_shim())

    async def _shim_event(self, kind: str, values: dict) -> None:
        """One event of the preload shim; returns when the tab applied it."""
        answer = None
        # The shim sends a line from inside a call of the tool, so the tool has the device
        # open. The 20 ms timer may not have seen that open yet.
        self.pty.check_open()
        if kind == "frame":
            if self.pty.held:
                # Web Serial opens a port with 7 or 8 data bits and 1 or 2 stop bits; a
                # value outside that stays the profile's.
                self._tool_frame = {"parity": values["parity"]}
                if values["dataBits"] in (7, 8):
                    self._tool_frame["dataBits"] = values["dataBits"]
                if values["stopBits"] in (1, 2):
                    self._tool_frame["stopBits"] = values["stopBits"]
                # The tool set its baud rate in the same call: one reopen of the port takes both.
                self._tool_baud = self.pty.speed()
                answer = self._configure()
        elif self.tab:
            answer = self.manager.post(self, {"type": "serial-signals", **values})
        if answer:
            # A refusal of the tab is in the log already; the tool goes on either way.
            with contextlib.suppress(BridgeError):
                await answer

    def _shim_socket(self) -> ShimSocket:
        return ShimSocket(self.manager.shim_dir, self.pty.minor, self._shim_event)

    def _profile(self) -> dict:
        return profiles.resolve(self.profile, self.overrides)

    def _target(self) -> dict:
        """The settings the port must be open with now."""
        profile = self._profile()
        settings = {field: profile[field] for field in profiles.SETTING_FIELDS}
        if self.pty.held:
            settings.update(self._tool_frame, baudRate=self._tool_baud)
        return settings

    def _configure(self) -> asyncio.Future | None:
        """Ask the tab for the settings that apply now, when they changed or the port is not open.

        Returns:
            The tab's answer to `serial-configure`; None when nothing was sent.
        """
        target = self._target()
        if target == self.settings and self.port_state == "open":
            return None
        self.settings = target
        if self.tab is None:
            return None
        return self.manager.post(self, {"type": "serial-configure", "settings": target})


class DeviceManager:
    """The device table of one Jupyter server.

    Args:
        device_dir: Directory of the virtual serial devices; made when the first
            serial port is claimed. The manager asks for its lock, and with the lock
            removes what a killed server left in it: at once when the directory
            exists, else at that first claim.
        monitor_bytes: Size of the monitor buffer of each serial port.
        log: The server's logger.
    """

    def __init__(self, device_dir: str, monitor_bytes: int, log: logging.Logger) -> None:
        self.device_dir = device_dir
        self.shim_dir = os.path.join(device_dir, ".shim")
        self.monitor_bytes = monitor_bytes
        self.log = log
        self.command_timeout = COMMAND_TIMEOUT_S  # seconds a tab has to ack a command
        self.tabs: dict[str, Tab] = {}
        self.serial: dict[str, SerialDevice] = {}
        self.usb: dict[str, UsbDevice] = {}
        self._names: dict[str, str] = {}  # key -> name, kept for the server's lifetime
        self._by_sid: dict[int, SerialDevice] = {}
        self._sids = itertools.count(1)
        self._seqs = itertools.count(1)
        self._acks: dict[int, tuple[asyncio.Future, asyncio.TimerHandle]] = {}
        self._requests: dict[str, dict] = {}
        self._answered: dict[str, asyncio.Event] = {}
        self._dir_lock: int | None = None  # the descriptor that holds the lock on the device directory
        self._dir_lock_tried = False
        if os.path.lexists(device_dir):
            try:
                self._take_dir()
            except OSError as error:
                log.error("device-bridge: what an ended server left in %s is not removed: %s",
                          device_dir, error)

    # ------------------------------------------------------------------------- tabs

    def connect(self, tab_id: str, serial: bool, usb: bool,
                send: Callable[[dict | bytes], None]) -> Tab:
        """Register the tab that said `hello` and send it the welcome, the table and the requests."""
        if not isinstance(tab_id, str) or not 0 < len(tab_id) <= 64:
            raise ValueError("hello without a tabId of 1 to 64 characters")
        if tab_id in self.tabs:
            # The tab reconnected before its old socket closed.
            self.disconnect(self.tabs[tab_id])
        tab = self.tabs[tab_id] = Tab(tab_id, bool(serial), bool(usb), send)
        tab.send({"type": "welcome", "tabId": tab_id, "profiles": profiles.PROFILES,
                  "deviceDir": self.device_dir})
        tab.send({"type": "devices", **self.table()})
        tab.send(self._requests_message())
        return tab

    def disconnect(self, tab: Tab) -> None:
        """The tab's socket closed: its devices become detached."""
        if self.tabs.get(tab.tab_id) is not tab:
            return
        del self.tabs[tab.tab_id]
        for device in (*self.serial.values(), *self.usb.values()):
            if device.tab == tab.tab_id:
                device.detach()
        self.devices_changed()

    async def receive(self, tab: Tab, message: dict) -> None:
        """Handle one text message of a tab.

        Raises:
            KeyError, TypeError, ValueError: The message lacks a field or carries a wrong value.
        """
        if self.tabs.get(tab.tab_id) is not tab:
            return  # a socket that a newer connection of the same tab replaced
        kind = message["type"]
        if kind == "claim":
            await self._claim(tab, message)
        elif kind == "ack":
            self._ack(message)
        elif kind == "ping":
            tab.send({"type": "pong", "t": message["t"]})
        elif kind == "release":
            self._release(tab, message)
        elif kind == "request-result":
            self._request_result(message)
        elif kind == "serial-state":
            device = self.serial.get(message["name"])
            if self._holds(tab, device):
                device.port_reported(message)
                self.devices_changed()
        elif kind == "usb-descriptors":
            device = self.usb.get(message["name"])
            if self._holds(tab, device):
                device.set_descriptors(dict(message["descriptors"]))
                self.devices_changed()
        elif kind == "stats":
            device = self._any(message["name"])
            if self._holds(tab, device):
                device.rx, device.tx = int(message["rx"]), int(message["tx"])
                self.devices_changed()
        else:
            raise ValueError(f"unknown message type {kind!r}")

    def port_data(self, tab: Tab, frame: bytes) -> None:
        """Handle one binary frame of a tab: bytes a serial port sent."""
        if self.tabs.get(tab.tab_id) is not tab or len(frame) < 3 or frame[0] != DATA_FRAME:
            return
        device = self._by_sid.get(int.from_bytes(frame[1:3], "big"))
        if self._holds(tab, device):
            device.port_data(frame[3:])

    @staticmethod
    def _holds(tab: Tab, device: "SerialDevice | UsbDevice | None") -> bool:
        """Whether this tab holds the device; only the holder reports on a device."""
        return device is not None and device.tab == tab.tab_id

    def _any(self, name: str) -> "SerialDevice | UsbDevice | None":
        """The device with this name of either kind; a name starts with its kind."""
        return self.serial.get(name) or self.usb.get(name)

    # ----------------------------------------------------------------------- claims

    async def _claim(self, tab: Tab, message: dict) -> None:
        key, info = message["key"], message.get("info")
        answer = {"type": "claimed", "key": key, "ok": False}
        try:
            device = await self._device(message["kind"], key, info if isinstance(info, dict) else {},
                                        message.get("defaults", {}))
        except (OSError, ValueError) as error:
            self.log.error("device-bridge: the claim of %r is refused: %s", key, error)
            tab.send(answer)
            return
        if device.tab not in (None, tab.tab_id):
            # With the name the refused tab knows which device of the table its grant
            # is for, also when another device has the same ids.
            tab.send({**answer, "name": device.name, "heldBy": device.tab})
            return
        device.attach(tab.tab_id)
        tab.send({**answer, "ok": True, **device.grant()})
        self.devices_changed()

    async def _device(self, kind: str, key: str, info: dict, defaults: object) -> SerialDevice | UsbDevice:
        """The device a key stands for; made at the first claim of the key.

        Args:
            defaults: The default serial settings of the tab's lab. They apply to a
                serial port that has no record; any other claim ignores them.

        Raises:
            ValueError: The kind or the key is malformed, or the default serial settings are refused.
            OSError: The device directory is refused, or the virtual serial device cannot be made.
        """
        match = kind in KINDS and isinstance(key, str) and _KEY_RES[kind].fullmatch(key)
        if not match:
            raise ValueError(f"it is not the key of a {kind} device")
        overrides = {}
        if kind == "serial" and self._names.get(key) not in self.serial:
            # Checked before the key gets a name and before anything is made for the port.
            overrides = profiles.default_overrides(defaults)
        vendor, product = match["vendor"], match["product"]
        name = self._name(key, f"{_NAME_PREFIXES[kind]}-{vendor}-{product}" if vendor else "tty-port")
        ids = (int(vendor, 16), int(product, 16)) if vendor else (None, None)
        if kind == "usb":
            if name not in self.usb:
                self.usb[name] = UsbDevice(
                    name, *ids,
                    product_name=_text(info.get("productName")),
                    manufacturer_name=_text(info.get("manufacturerName")),
                    serial_number=_text(info.get("serialNumber")),
                )
            return self.usb[name]
        if name not in self.serial:
            self._take_dir()
            device = self.serial[name] = SerialDevice(self, name, next(self._sids), *ids, overrides)
            self._by_sid[device.sid] = device
            await device.start_shim()
        return self.serial[name]

    def _name(self, key: str, base: str) -> str:
        """The name of a key; the second device with one base name gets `-2`, the third `-3`."""
        if key not in self._names:
            taken = set(self._names.values())
            candidates = itertools.chain([base], (f"{base}-{n}" for n in itertools.count(2)))
            self._names[key] = next(name for name in candidates if name not in taken)
        return self._names[key]

    def _release(self, tab: Tab, message: dict) -> None:
        reason = message["reason"]
        device = self._any(message["name"])
        if device is None:
            return
        owned = self._holds(tab, device)
        # A tab forgets a device it holds or a detached one, never the device of another tab.
        if reason == "forget" and (owned or device.tab is None):
            self._forget(device)
        elif owned and reason in ("detach", "removed"):
            device.detach("removed" if reason == "removed" else None)
        else:
            return
        self.devices_changed()

    def _forget(self, device: SerialDevice | UsbDevice) -> None:
        """Remove a device from the table. Its key keeps its name for a later grant."""
        if isinstance(device, UsbDevice):
            del self.usb[device.name]
            return
        del self.serial[device.name]
        del self._by_sid[device.sid]
        device.close()

    # --------------------------------------------------------------------- commands

    def command(self, device: SerialDevice | UsbDevice, message: dict,
                timeout: float | None = None) -> asyncio.Future:
        """Send one command to the tab that holds a device.

        The command leaves before this call returns, so commands and data frames
        reach the tab in the order they were issued.

        Args:
            device: The device the command is for.
            message: The command without `seq` and `name`.
            timeout: Seconds to wait for the ack; `command_timeout` when omitted.

        Returns:
            A future with the `result` of the tab's ack. It fails with `BridgeError`
            502 when the browser refused, and 504 when no ack came in time.

        Raises:
            BridgeError: 409, no tab holds the device.
        """
        tab = self.tabs.get(device.tab)
        if tab is None:
            if self.tabs:
                raise BridgeError(409, "detached", f"{device.name} is detached: no lab tab holds it")
            raise BridgeError(409, "no-tab", f"{device.name} is detached: no lab tab is connected")
        seq = next(self._seqs)
        loop = asyncio.get_running_loop()
        answer = loop.create_future()
        self._acks[seq] = (answer, loop.call_later(timeout or self.command_timeout, self._expire, seq))
        tab.send({**message, "seq": seq, "name": device.name})
        return answer

    def post(self, device: SerialDevice | UsbDevice, message: dict) -> asyncio.Future:
        """Send a command that no caller waits for; a failure goes to the log."""
        answer = self.command(device, message)
        answer.add_done_callback(functools.partial(self._log_failure, device.name, message["type"]))
        return answer

    def send_data(self, device: SerialDevice, chunk: bytes) -> None:
        """Send bytes for a serial port to the tab that holds it; dropped while it is detached."""
        tab = self.tabs.get(device.tab)
        if tab:
            tab.send(bytes([DATA_FRAME]) + device.sid.to_bytes(2, "big") + chunk)

    def _log_failure(self, name: str, kind: str, answer: asyncio.Future) -> None:
        error = None if answer.cancelled() else answer.exception()
        if error:
            self.log.warning("device-bridge: %s of %s failed: %s", kind, name, error.message)

    def _ack(self, message: dict) -> None:
        answer, timer = self._acks.pop(message["seq"], (None, None))
        if answer is None:
            return  # the command already timed out
        timer.cancel()
        if answer.done():
            return  # the caller stopped waiting
        if message.get("ok"):
            answer.set_result(message.get("result"))
            return
        error = message.get("error")
        error = error if isinstance(error, dict) else {}
        answer.set_exception(BridgeError(
            502, "browser", _text(error.get("message")) or "the browser refused the operation",
            _text(error.get("name"))))

    def _expire(self, seq: int) -> None:
        answer, _ = self._acks.pop(seq)
        if not answer.done():
            answer.set_exception(BridgeError(504, "timeout", "the tab did not answer in time"))

    # ---------------------------------------------------------- what programs ask for

    def status(self) -> dict:
        """Connected tabs, directories and counts for `GET status`."""
        return {
            "deviceDir": self.device_dir,
            "shimDir": self.shim_dir,
            "tabs": [{"tabId": tab.tab_id, "serial": tab.serial, "usb": tab.usb,
                      "roundTrip": tab.round_trip} for tab in self.tabs.values()],
            "counts": {"serial": len(self.serial), "usb": len(self.usb),
                       "requests": len(self._pending_requests())},
        }

    def table(self) -> dict:
        """The whole device table: `{serial: [...], usb: [...]}`."""
        return {"serial": [device.record() for device in self.serial.values()],
                "usb": [device.record() for device in self.usb.values()]}

    def serial_device(self, name: str) -> SerialDevice:
        """The serial device with this name.

        Raises:
            BridgeError: 400 for a name outside the pattern, 404 for an unknown device.
        """
        return self._find(self.serial, "serial", name)

    def usb_device(self, name: str) -> UsbDevice:
        """The USB device with this name.

        Raises:
            BridgeError: 400 for a name outside the pattern, 404 for an unknown device.
        """
        return self._find(self.usb, "usb", name)

    def _find(self, table: dict, kind: str, name: str) -> SerialDevice | UsbDevice:
        # The pattern is checked before the name is used for anything.
        if not NAME_RE.fullmatch(name):
            raise BridgeError(400, "invalid-name",
                              "a device name is 1 to 64 of the characters a-z, 0-9 and -")
        if name not in table:
            raise BridgeError(404, "unknown-device", f"no {kind} device named {name}")
        return table[name]

    def set_profile(self, name: str, change: dict) -> dict:
        """Set the profile id or single fields of a serial device; returns its record."""
        device = self.serial_device(name)
        try:
            device.set_profile(profiles.validate_change(change))
        except profiles.ProfileError as error:
            raise BridgeError(400, "bad-profile", str(error)) from None
        self.devices_changed()
        return device.record()

    async def serial_write(self, name: str, body: dict) -> None:
        """Write `{data}` (base64) to the port."""
        device = self.serial_device(name)
        data = body.get("data")
        try:
            if not isinstance(data, str):
                raise ValueError
            base64.b64decode(data, validate=True)
        except ValueError:
            raise BridgeError(400, "bad-request", "data: the bytes as base64 text") from None
        await self.command(device, {"type": "serial-write", "data": data})

    async def serial_signals(self, name: str, body: dict) -> None:
        """Set the control lines named in `{dtr?, rts?, brk?}`."""
        device = self.serial_device(name)
        if not body or any(line not in SIGNALS or not isinstance(level, bool)
                           for line, level in body.items()):
            raise BridgeError(400, "bad-request",
                              "signals: at least one of dtr, rts and brk, each true or false")
        await self.command(device, {"type": "serial-signals", **body})

    async def serial_action(self, name: str, body: dict) -> None:
        """Run the action of `{action}` on the port."""
        device = self.serial_device(name)
        action = body.get("action")
        if action not in profiles.ACTIONS:
            raise BridgeError(400, "bad-request",
                              f"action: {action!r} is not one of {', '.join(profiles.ACTIONS)}")
        await self.command(device, {"type": "serial-action", "action": action})

    async def usb_operation(self, name: str, op: str, body: dict) -> dict:
        """Run one USB operation in the browser and return its result."""
        device = self.usb_device(name)
        try:
            program = usb.take_program(op, body)
            args, seconds = usb.plan(op, body, self.command_timeout)
        except ValueError as error:
            raise BridgeError(400, "bad-request", str(error)) from None
        try:
            result = await self.command(device, {"type": "usb", "op": op, "args": args}, seconds)
        except BridgeError as error:
            if error.name != "TimeoutError":
                raise
            # The tab ended a transfer in that got no data in time. To the caller
            # that is the same as a tab that did not answer in time.
            raise BridgeError(504, "timeout", error.message) from None
        if op in ("open", "close"):
            device.set_opened(op == "open", program)
            self.devices_changed()
        return result or {}

    # -------------------------------------------------------------- device requests

    def create_request(self, body: dict) -> dict:
        """List a program's request for a device that is not granted yet.

        Args:
            body: `{kind, vendorId?, productId?, reason, program}`.

        Returns:
            The request record with its `id` and `state` `pending`.
        """
        if body.get("kind") not in KINDS:
            raise BridgeError(400, "bad-request", "kind: serial or usb")
        request = {"id": secrets.token_hex(4), "kind": body["kind"]}
        for field in ("vendorId", "productId"):
            value = body.get(field)
            if value is None:
                continue
            if type(value) is not int or not 0 <= value <= 0xFFFF:
                raise BridgeError(400, "bad-request", f"{field}: a whole number from 0 to 65535")
            request[field] = value
        for field in ("reason", "program"):
            value = body.get(field)
            if not isinstance(value, str) or not value.strip():
                raise BridgeError(400, "bad-request", f"{field}: a text that is not empty")
            request[field] = value
        request["state"] = "pending"
        self._requests[request["id"]] = request
        self._answered[request["id"]] = asyncio.Event()
        asyncio.get_running_loop().call_later(REQUEST_TTL_S, self._end_request, request, "expired")
        self._broadcast(self._requests_message())
        return request

    def requests(self) -> list[dict]:
        """Every device request of this server's lifetime, with its state."""
        return list(self._requests.values())

    async def request(self, request_id: str, wait: float = 0.0) -> dict:
        """A request record; with `wait` the call returns when the request is answered or the time ends.

        Raises:
            BridgeError: 404, no such request.
        """
        if request_id not in self._requests:
            raise BridgeError(404, "unknown-request", f"no device request {request_id}")
        request = self._requests[request_id]
        if request["state"] == "pending" and wait > 0:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._answered[request_id].wait(), wait)
        return request

    def _request_result(self, message: dict) -> None:
        request = self._requests.get(message["id"])
        if request is None:
            return
        if message.get("ok"):
            self._end_request(request, "granted", name=_text(message.get("name")))
        else:
            error = message.get("error")
            self._end_request(request, "denied", error=error if isinstance(error, dict) else None)

    def _end_request(self, request: dict, state: str, **outcome: object) -> None:
        if request["state"] != "pending":
            return
        request.update(state=state, **outcome)
        self._answered[request["id"]].set()
        self._broadcast(self._requests_message())

    def _pending_requests(self) -> list[dict]:
        return [request for request in self._requests.values() if request["state"] == "pending"]

    def _requests_message(self) -> dict:
        # A tab gets the fields a program posted and the id; every listed request is pending.
        return {"type": "requests", "pending": [
            {field: value for field, value in request.items() if field != "state"}
            for request in self._pending_requests()]}

    # -------------------------------------------------------------------- the whole

    def devices_changed(self) -> None:
        """Send the whole device table to every tab."""
        self._broadcast({"type": "devices", **self.table()})

    def _broadcast(self, message: dict) -> None:
        for tab in list(self.tabs.values()):
            tab.send(message)

    def _take_dir(self) -> None:
        """Lock the device directory and remove what a killed server left in it; once per manager.

        Raises:
            OSError: The directory is refused or cannot be made, and the next call tries
                again; or an entry cannot be removed, and no call tries that again.
        """
        if self._dir_lock_tried:
            return
        self._dir_lock = lock_dir(self.device_dir)
        self._dir_lock_tried = True
        if self._dir_lock is None:
            self.log.warning(
                "device-bridge: another live server uses the device directory %s, so nothing in it "
                "is removed; give this server its own directory with the setting "
                "DeviceBridge.device_dir", self.device_dir)
            return
        remove_left(self.device_dir, self.shim_dir)

    def close(self) -> None:
        """Remove every virtual serial device and shim socket, then unlock the device directory.

        Safe to call twice.
        """
        for device in self.serial.values():
            device.close()
        self.serial.clear()
        self._by_sid.clear()
        if self._dir_lock is not None:
            os.close(self._dir_lock)
            self._dir_lock = None
