"""Routes of the device bridge: the WebSocket of the lab tabs and the REST API of the programs.

Everything is under `<base_url>jupyterlab-device-bridge-extension/` and behind Jupyter's
authentication. docs/design.md lists the messages and the routes.
"""

import base64
import json
import os
import struct
import time

import tornado.web
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.utils import url_path_join
from tornado.websocket import WebSocketClosedError, WebSocketHandler

from . import __version__, profiles
from .manager import BridgeError, DeviceManager, Tab

NAMESPACE = "jupyterlab-device-bridge-extension"
MANAGER_KEY = "device_bridge_manager"
# Payload of the WebSocket ping that measures the round trip: the time it was sent.
_STAMP = struct.Struct("d")


class BridgeHandler(APIHandler):
    """Base of the REST handlers: the manager, the request's values and the error body."""

    @property
    def manager(self) -> DeviceManager:
        """The device manager of this server."""
        return self.settings[MANAGER_KEY]

    def body(self) -> dict:
        """The JSON object of the request body.

        Raises:
            BridgeError: 400, the body is not one JSON object.
        """
        try:
            body = json.loads(self.request.body or b"{}")
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise BridgeError(400, "bad-request", "the body must be one JSON object")
        return body

    def number(self, name: str, kind: type) -> int | float:
        """A query argument that is a number of 0 or more; 0 when it is absent.

        Raises:
            BridgeError: 400, the argument is not such a number.
        """
        try:
            value = kind(self.get_query_argument(name, "0"))
            if not 0 <= value < float("inf"):
                raise ValueError
        except ValueError:
            raise BridgeError(400, "bad-request", f"{name}: a number of 0 or more") from None
        return value

    def write_error(self, status_code: int, **kwargs: object) -> None:
        """Answer a `BridgeError` as `{error: {code, message, name?}}`; anything else as Jupyter does."""
        error = kwargs["exc_info"][1] if "exc_info" in kwargs else None
        if not isinstance(error, BridgeError):
            super().write_error(status_code, **kwargs)
            return
        detail = {"code": error.code, "message": error.message}
        if error.name:
            detail["name"] = error.name
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"error": detail}))


def terminal_shell(settings: dict) -> list[str]:
    """The words of the shell command of the lab's terminals, from the settings of the web application.

    It is the shell command of the server's terminal manager. A server without terminals
    has no such manager: then it is the server's variable SHELL, and /bin/sh without it.
    """
    terminals = settings.get("terminal_manager")
    if terminals is None:
        return [os.environ.get("SHELL") or "/bin/sh"]
    return list(terminals.shell_command)


class StatusHandler(BridgeHandler):
    """`GET status`: version, directories, shell command of the terminals, connected tabs and counts."""

    @tornado.web.authenticated
    def get(self) -> None:
        shell = terminal_shell(self.settings)
        self.finish(json.dumps({"version": __version__, "shell": shell, **self.manager.status()}))


class DevicesHandler(BridgeHandler):
    """`GET devices`: the device table."""

    @tornado.web.authenticated
    def get(self) -> None:
        self.finish(json.dumps(self.manager.table()))


class ProfilesHandler(BridgeHandler):
    """`GET profiles`: the built-in serial profiles."""

    @tornado.web.authenticated
    def get(self) -> None:
        self.finish(json.dumps({"profiles": profiles.PROFILES}))


class SerialProfileHandler(BridgeHandler):
    """`PUT serial/<name>/profile`: set the profile id or single fields; answers the record."""

    @tornado.web.authenticated
    def put(self, name: str) -> None:
        self.finish(json.dumps(self.manager.set_profile(name, self.body())))


class SerialMonitorHandler(BridgeHandler):
    """`GET serial/<name>/monitor?since=<offset>&wait=<seconds>`: bytes the port sent."""

    @tornado.web.authenticated
    async def get(self, name: str) -> None:
        monitor = self.manager.serial_device(name).monitor
        chunk = await monitor.read(self.number("since", int), self.number("wait", float))
        chunk["data"] = base64.b64encode(chunk["data"]).decode()
        self.finish(json.dumps(chunk))


class SerialCommandHandler(BridgeHandler):
    """`POST serial/<name>/write|signals|action`: one command for the port."""

    @tornado.web.authenticated
    async def post(self, name: str, command: str) -> None:
        commands = {"write": self.manager.serial_write, "signals": self.manager.serial_signals,
                    "action": self.manager.serial_action}
        await commands[command](name, self.body())
        self.finish("{}")


class RequestsHandler(BridgeHandler):
    """`GET requests` and `POST requests`: the device requests of programs."""

    @tornado.web.authenticated
    def get(self) -> None:
        self.finish(json.dumps({"requests": self.manager.requests()}))

    @tornado.web.authenticated
    def post(self) -> None:
        self.finish(json.dumps(self.manager.create_request(self.body())))


class RequestHandler(BridgeHandler):
    """`GET requests/<id>?wait=<seconds>`: one device request, when it is answered or the time ends."""

    @tornado.web.authenticated
    async def get(self, request_id: str) -> None:
        self.finish(json.dumps(await self.manager.request(request_id, self.number("wait", float))))


class RunsHandler(BridgeHandler):
    """`GET runs` and `POST runs`: the processes that `jupyterlab-device run` started."""

    @tornado.web.authenticated
    def get(self) -> None:
        self.finish(json.dumps({"runs": self.manager.runs()}))

    @tornado.web.authenticated
    def post(self) -> None:
        self.finish(json.dumps(self.manager.register_run(self.body())))


class RunHandler(BridgeHandler):
    """`DELETE runs/<pid>`: stop one run; answers 204 once the stop signal was sent."""

    @tornado.web.authenticated
    def delete(self, pid: str) -> None:
        self.manager.stop_run(pid)
        self.set_status(204)
        self.finish()


class UsbHandler(BridgeHandler):
    """`GET usb/<name>`: the descriptors of a USB device."""

    @tornado.web.authenticated
    def get(self, name: str) -> None:
        self.finish(json.dumps(self.manager.usb_device(name).descriptors))


class UsbOperationHandler(BridgeHandler):
    """`POST usb/<name>/<op>`: one USB operation in the browser; answers its result."""

    @tornado.web.authenticated
    async def post(self, name: str, op: str) -> None:
        self.finish(json.dumps(await self.manager.usb_operation(name, op, self.body())))


class TabSocketHandler(WebSocketMixin, WebSocketHandler, JupyterHandler):
    """The WebSocket of one lab tab: text frames are protocol messages, binary frames serial data."""

    _tab: Tab | None = None

    @property
    def manager(self) -> DeviceManager:
        """The device manager of this server."""
        return self.settings[MANAGER_KEY]

    def set_default_headers(self) -> None:
        """Undo JupyterHandler's default headers, which are meaningless for websockets."""

    @ws_authenticated
    async def get(self, *args: object, **kwargs: object) -> None:
        await super().get(*args, **kwargs)

    async def on_message(self, message: str | bytes) -> None:
        if isinstance(message, bytes):
            if self._tab:
                self.manager.port_data(self._tab, message)
            return
        try:
            message = json.loads(message)
            if message["type"] == "hello":
                self._tab = self.manager.connect(
                    message["tabId"], message.get("serial"), message.get("usb"), self._send)
            elif self._tab:
                await self.manager.receive(self._tab, message)
                if message["type"] == "ping":
                    # The tab's ping is the moment to measure the server's own round trip.
                    self.ping(_STAMP.pack(time.monotonic()))
        except (KeyError, TypeError, ValueError):
            self.log.warning("device-bridge: a message of the tab is ignored", exc_info=True)

    def on_pong(self, data: bytes) -> None:
        super().on_pong(data)
        if self._tab and len(data) == _STAMP.size:
            (sent,) = _STAMP.unpack(data)
            self._tab.round_trip = round((time.monotonic() - sent) * 1000, 1)

    def on_close(self) -> None:
        if self._tab:
            self.manager.disconnect(self._tab)

    def _send(self, message: dict | bytes) -> None:
        """Send one frame to the tab; nothing when the socket has closed."""
        binary = isinstance(message, bytes)
        try:
            sent = self.write_message(message if binary else json.dumps(message), binary=binary)
        except WebSocketClosedError:
            return  # on_close detaches the devices of this tab
        # A socket that closes during the write fails this future; take the error from it.
        sent.add_done_callback(lambda done: done.exception())


def setup_route_handlers(web_app: tornado.web.Application) -> None:
    """Register the WebSocket and the REST handlers under the server's base URL."""
    name = r"([^/]+)"
    routes = [
        (r"ws", TabSocketHandler),
        (r"status", StatusHandler),
        (r"devices", DevicesHandler),
        (r"profiles", ProfilesHandler),
        (rf"serial/{name}/profile", SerialProfileHandler),
        (rf"serial/{name}/monitor", SerialMonitorHandler),
        (rf"serial/{name}/(write|signals|action)", SerialCommandHandler),
        (r"requests", RequestsHandler),
        (rf"requests/{name}", RequestHandler),
        (r"runs", RunsHandler),
        (rf"runs/{name}", RunHandler),
        (rf"usb/{name}", UsbHandler),
        (rf"usb/{name}/{name}", UsbOperationHandler),
    ]
    base = url_path_join(web_app.settings["base_url"], NAMESPACE)
    web_app.add_handlers(".*$", [(url_path_join(base, route), handler) for route, handler in routes])
