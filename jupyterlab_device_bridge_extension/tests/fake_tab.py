"""A test double of the browser tab.

`FakeTab` connects to the test server's WebSocket and speaks the tab side of the
protocol of docs/design.md, as the worker in `src/worker.ts` does. It simulates one
serial port per claimed serial key and one USB device.

    async def test_something(fake_tab, api, tool):
        tab = await fake_tab()                      # hello, welcome
        name = (await tab.claim_serial())["name"]   # claim, claimed, port open
        await tab.port_sends(name, b"boot\\n")       # the port sent bytes
        status, chunk = await api("GET", "serial", name, "monitor")

The fixtures `fake_tab`, `api`, `tool` and `bridge_address` are in the `conftest.py` of
the repository. The tab runs on the event loop of the test, and so does the server. A
blocking client (the CLI, the Python client, a serial tool) must run in a thread or a
child process, or the tab and the server stop with it:

    url, token = bridge_address
    devices = await asyncio.to_thread(DeviceBridgeClient(url, token).devices)
    child = await tool(SCRIPT, path)                # `python -c SCRIPT path`

What a test sets:

- `echo` (default True): a serial port sends back every byte written to it
- `answers` (default True): False makes the tab ack no command at all
- `error` (default None): `(name, message)` that every command is refused with
- `stall` (default False): the USB device ends every transfer with status `stall`

What a test reads:

- `events`: everything the server sent, in order. A text frame is its message; a
  binary frame is `{"type": "data", "name": ..., "data": bytes}`
- `got(kind)`: the events of one type, for example `got("serial-configure")`
- `written(name)`: every byte written to a serial port, from data frames and `serial-write`
- `welcome`, `devices`, `requests`, `runs`: the last message of that type
- `settings[name]`, `signals[name]`: what a serial port is open with and its control lines
- `usb_calls`: `(op, args)` of every USB operation; `usb_opened`; `loopback`

The USB device has the ids `USB_VENDOR:USB_PRODUCT`, the strings `USB_MANUFACTURER`,
`USB_PRODUCT_NAME` and `USB_SERIAL`, and one vendor interface with a bulk OUT and a
bulk IN endpoint, both number `USB_ENDPOINT`: IN returns what OUT got. Its control
endpoint answers GET_DESCRIPTOR with `DEVICE_DESCRIPTOR`, `CONFIGURATION_DESCRIPTOR`
and the string descriptors, GET_CONFIGURATION with 1, and any other request in with
`VENDOR_ANSWER`. A transfer in on the empty loopback waits for its `timeout` and is
then refused with `TimeoutError`, as the worker does.
"""

import asyncio
import base64
import json
import struct

import tornado.httpclient
import tornado.websocket

SERIAL_KEY = "s:2341:0043:0"
SERIAL_NAME = "tty-2341-0043"

USB_VENDOR, USB_PRODUCT = 0xCAFE, 0x4001
USB_MANUFACTURER, USB_PRODUCT_NAME, USB_SERIAL = "Simulated Devices", "Loopback", "SN0001"
USB_KEY = f"u:{USB_VENDOR:04x}:{USB_PRODUCT:04x}:{USB_SERIAL}"
USB_NAME = f"usb-{USB_VENDOR:04x}-{USB_PRODUCT:04x}"
USB_ENDPOINT = 1
USB_STRINGS = {1: USB_MANUFACTURER, 2: USB_PRODUCT_NAME, 3: USB_SERIAL}
DEVICE_DESCRIPTOR = struct.pack(
    "<BBHBBBBHHHBBBB", 18, 1, 0x0200, 0, 0, 0, 64, USB_VENDOR, USB_PRODUCT, 0x0100, 1, 2, 3, 1)
CONFIGURATION_DESCRIPTOR = bytes([
    9, 2, 32, 0, 1, 1, 0, 0x80, 50,   # configuration 1 with one interface
    9, 4, 0, 0, 2, 0xFF, 0, 0, 0,     # interface 0, vendor class, two endpoints
    7, 5, 0x01, 2, 64, 0, 0,          # bulk OUT 1
    7, 5, 0x81, 2, 64, 0, 0,          # bulk IN 1, which returns what OUT 1 got
])
VENDOR_ANSWER = b"\xde\xad\xbe\xef"
USB_DESCRIPTORS = {
    "usbVersionMajor": 2, "usbVersionMinor": 0, "usbVersionSubminor": 0,
    "deviceClass": 0, "deviceSubclass": 0, "deviceProtocol": 0,
    "vendorId": USB_VENDOR, "productId": USB_PRODUCT,
    "deviceVersionMajor": 1, "deviceVersionMinor": 0, "deviceVersionSubminor": 0,
    "manufacturerName": USB_MANUFACTURER, "productName": USB_PRODUCT_NAME,
    "serialNumber": USB_SERIAL, "configurationValue": 1,
    "configurations": [{
        "configurationValue": 1, "configurationName": None,
        "interfaces": [{
            "interfaceNumber": 0, "claimed": False, "alternateSetting": 0,
            "alternates": [{
                "alternateSetting": 0, "interfaceClass": 0xFF, "interfaceSubclass": 0,
                "interfaceProtocol": 0, "interfaceName": None,
                "endpoints": [
                    {"endpointNumber": USB_ENDPOINT, "direction": "out", "type": "bulk", "packetSize": 64},
                    {"endpointNumber": USB_ENDPOINT, "direction": "in", "type": "bulk", "packetSize": 64},
                ],
            }],
        }],
    }],
}
_GET_DESCRIPTOR, _GET_CONFIGURATION = 6, 8
_TRANSFERS = ("control-in", "control-out", "transfer-in", "transfer-out")
POLL_S = 0.01


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _string_descriptor(index: int) -> bytes:
    if index == 0:
        return bytes([4, 3, 0x09, 0x04])  # the language list: English (United States)
    text = USB_STRINGS[index].encode("utf-16-le")
    return bytes([len(text) + 2, 3]) + text


class FakeTab:
    """One lab tab on the bridge's WebSocket. Make it with the `fake_tab` fixture."""

    def __init__(self, socket, tab_id: str) -> None:
        self.tab_id = tab_id
        self.echo = True
        self.answers = True
        self.error: tuple[str, str] | None = None
        self.stall = False
        self.events: list[dict] = []
        self.welcome: dict | None = None
        self.devices: dict | None = None
        self.requests: dict | None = None
        self.runs: dict | None = None
        self.settings: dict[str, dict] = {}
        self.signals: dict[str, dict] = {}
        self.usb_calls: list[tuple[str, dict]] = []
        self.usb_opened = False
        self.loopback = bytearray()
        self._socket = socket
        self._claimed: dict[str, dict] = {}  # key -> the server's answer
        self._sids: dict[int, str] = {}      # sid -> name of the serial port
        self._arrived = asyncio.Event()      # bytes arrived in the loopback
        self._tasks: set[asyncio.Task] = set()
        self._reader: asyncio.Task | None = None

    @classmethod
    async def connect(cls, url: str, headers: dict, tab_id: str = "tab-1") -> "FakeTab":
        """Open the bridge's WebSocket, say hello and wait for the welcome and the three lists after it.

        Args:
            url: `ws://127.0.0.1:<port><base_url>jupyterlab-device-bridge-extension/ws`.
            headers: Request headers with the server's token.
            tab_id: The id this tab says hello with.
        """
        request = tornado.httpclient.HTTPRequest(url, headers=headers)
        tab = cls(await tornado.websocket.websocket_connect(request), tab_id)
        tab._reader = asyncio.ensure_future(tab._read())
        await tab.send({"type": "hello", "tabId": tab_id, "serial": True, "usb": True})
        await tab.until(lambda: tab.welcome and tab.devices and tab.requests and tab.runs)
        return tab

    # ------------------------------------------------------------- what the tab does

    async def send(self, message: dict) -> None:
        """Send any tab message, for example a `release`, `stats` or `request-result`."""
        await self._socket.write_message(json.dumps(message))

    async def claim_serial(self, key: str = SERIAL_KEY, **fields) -> dict:
        """Claim a serial key; on `ok` the port is open with the settings the server gave.

        Args:
            key: The key of the port.
            **fields: More fields of the claim message. `defaults={...}` is the default
                serial settings of the lab, as the worker sends them.

        Returns:
            The server's `claimed` message: `ok`, `name`, `sid`, `settings`, or `heldBy`.
        """
        ids = key.split(":")[1:-1]  # two USB ids, or `port` for a port without them
        info = dict(zip(("usbVendorId", "usbProductId"), (int(part, 16) for part in ids))) if len(ids) == 2 else {}
        return await self._claim("serial", key, info, **fields)

    async def claim_usb(self, key: str = USB_KEY) -> dict:
        """Claim the USB device; on `ok` the tab sends its descriptors.

        Returns:
            The server's `claimed` message: `ok` and `name`, or `heldBy`.
        """
        return await self._claim("usb", key, {
            "vendorId": USB_VENDOR, "productId": USB_PRODUCT, "serialNumber": USB_SERIAL,
            "productName": USB_PRODUCT_NAME, "manufacturerName": USB_MANUFACTURER})

    async def port_sends(self, name: str, data: bytes) -> None:
        """The serial port `name` sent these bytes."""
        sid = next(sid for sid, port in self._sids.items() if port == name)
        await self._socket.write_message(b"\x01" + sid.to_bytes(2, "big") + data, binary=True)

    async def release(self, name: str, reason: str = "detach") -> None:
        """Give a device up; `reason` is `detach`, `forget` or `removed`."""
        await self.send({"type": "release", "name": name, "reason": reason})

    async def close(self) -> None:
        """Close the WebSocket, as a closed tab does.

        Raises:
            Exception: What stopped the tab while it handled a message of the server.
        """
        self._socket.close()
        tasks = [self._reader, *self._tasks]
        for task in tasks:
            task.cancel()
        for outcome in await asyncio.gather(*tasks, return_exceptions=True):
            if isinstance(outcome, Exception):
                raise outcome

    # ------------------------------------------------------------ what the tab got

    def got(self, kind: str) -> list[dict]:
        """The events of one type, in the order they arrived."""
        return [event for event in self.events if event["type"] == kind]

    def written(self, name: str) -> bytes:
        """Every byte written to a serial port so far."""
        return b"".join(
            event["data"] if event["type"] == "data" else base64.b64decode(event["data"])
            for event in self.events
            if event["type"] in ("data", "serial-write") and event["name"] == name)

    async def until(self, condition, timeout: float = 5.0):
        """Wait until `condition()` is true and return its value.

        Raises:
            AssertionError: The condition stayed false for `timeout` seconds.
            Exception: What stopped the tab while it handled a message of the server.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while not (value := condition()):
            if self._reader.done() and self._reader.exception():
                raise self._reader.exception()
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError(f"not true within {timeout} s; the tab got {self.events[-5:]}")
            await asyncio.sleep(POLL_S)
        return value

    # --------------------------------------------------------------- the simulation

    async def _claim(self, kind: str, key: str, info: dict, **fields) -> dict:
        self._claimed.pop(key, None)
        await self.send({"type": "claim", "kind": kind, "key": key, "info": info, **fields})
        return await self.until(lambda: self._claimed.get(key))

    async def _read(self) -> None:
        while (frame := await self._socket.read_message()) is not None:
            if isinstance(frame, bytes):
                name = self._sids[int.from_bytes(frame[1:3], "big")]
                self.events.append({"type": "data", "name": name, "data": frame[3:]})
                await self._port_got(name, frame[3:])
                continue
            message = json.loads(frame)
            self.events.append(message)
            kind = message["type"]
            if kind in ("welcome", "devices", "requests", "runs"):
                setattr(self, kind, message)
            elif kind == "claimed":
                await self._on_claimed(message)
            elif kind == "usb":
                # Each USB operation runs by itself: a transfer in that waits for
                # data holds no other command back.
                task = asyncio.ensure_future(self._answer(message, self._usb(message)))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
            elif kind.startswith("serial-"):
                await self._answer(message, self._serial(message))

    async def _on_claimed(self, message: dict) -> None:
        self._claimed[message["key"]] = message
        if not message["ok"]:
            return
        name = message["name"]
        if "sid" not in message:
            await self._send_descriptors(name)
            return
        self._sids[message["sid"]] = name
        self.settings[name] = message["settings"]
        self.signals[name] = {}
        await self._send_state(name)

    async def _send_state(self, name: str) -> None:
        await self.send({"type": "serial-state", "name": name, "state": "open",
                         "settings": self.settings[name], "signals": self.signals[name]})

    async def _send_descriptors(self, name: str) -> None:
        descriptors = {**USB_DESCRIPTORS, "opened": self.usb_opened}
        if self.usb_opened:
            descriptors["raw"] = {"device": _b64(DEVICE_DESCRIPTOR),
                                  "configurations": [_b64(CONFIGURATION_DESCRIPTOR)]}
        await self.send({"type": "usb-descriptors", "name": name, "descriptors": descriptors})

    async def _answer(self, message: dict, work) -> None:
        """Run the work of one command and answer it with one ack."""
        if not self.answers:
            work.close()
            return
        ack = {"type": "ack", "seq": message["seq"], "ok": self.error is None}
        if self.error:
            work.close()
            ack["error"] = dict(zip(("name", "message"), self.error))
        else:
            result = await work
            if isinstance(result, tuple):
                ack.update(ok=False, error=dict(zip(("name", "message"), result)))
            elif result:
                ack["result"] = result
        await self.send(ack)

    async def _port_got(self, name: str, data: bytes) -> None:
        if self.echo:
            await self.port_sends(name, data)

    async def _serial(self, message: dict) -> None:
        name = message["name"]
        if message["type"] == "serial-configure":
            self.settings[name] = message["settings"]
            await self._send_state(name)
        elif message["type"] == "serial-signals":
            self.signals[name].update(
                {line: message[line] for line in ("dtr", "rts", "brk") if line in message})
            await self._send_state(name)
        elif message["type"] == "serial-write":
            await self._port_got(name, base64.b64decode(message["data"]))

    async def _usb(self, message: dict) -> dict | tuple[str, str] | None:
        """One USB operation: its result, `(name, message)` of a refusal, or None."""
        op, args = message["op"], message.get("args") or {}
        self.usb_calls.append((op, args))
        if self.stall and op in _TRANSFERS:
            return {"status": "stall"}
        if op in ("open", "close"):
            self.usb_opened = op == "open"
            if self.usb_opened:
                await self._send_descriptors(message["name"])
        elif op == "control-in":
            return {"status": "ok", "data": _b64(self._control_in(args)[:args["length"]])}
        elif op == "control-out":
            return {"status": "ok", "bytesWritten": len(base64.b64decode(args.get("data", "")))}
        elif op == "transfer-out":
            data = base64.b64decode(args["data"])
            self.loopback += data
            self._arrived.set()
            return {"status": "ok", "bytesWritten": len(data)}
        elif op == "transfer-in":
            return await self._transfer_in(args)
        return None

    def _control_in(self, args: dict) -> bytes:
        if (args["requestType"], args["request"]) == ("standard", _GET_DESCRIPTOR):
            kind, index = args["value"] >> 8, args["value"] & 0xFF
            return {1: DEVICE_DESCRIPTOR, 2: CONFIGURATION_DESCRIPTOR}.get(kind) or _string_descriptor(index)
        if (args["requestType"], args["request"]) == ("standard", _GET_CONFIGURATION):
            return b"\x01"
        return VENDOR_ANSWER

    async def _transfer_in(self, args: dict) -> dict | tuple[str, str]:
        if not self.loopback:
            self._arrived.clear()
            try:
                await asyncio.wait_for(self._arrived.wait(), args["timeout"] / 1000)
            except asyncio.TimeoutError:
                return ("TimeoutError", f"No data on endpoint {args['endpointNumber']} "
                                        f"within {args['timeout']} ms")
        data = bytes(self.loopback[:args["length"]])
        del self.loopback[:len(data)]
        return {"status": "ok", "data": _b64(data)}
