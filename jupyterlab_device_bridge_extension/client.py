"""Python client of the device bridge: the REST API of the Jupyter server extension.

    from jupyterlab_device_bridge_extension.client import DeviceBridgeClient

    bridge = DeviceBridgeClient()
    probe = bridge.usb("usb-0d28-0204")
    probe.open()
    probe.claim_interface(0)
    probe.transfer_out(1, b"\\x00\\x02")
    answer = probe.transfer_in(1, 64, timeout_ms=1000)

The client finds the running Jupyter server and its token the way the
`jupyterlab-device` CLI does, and talks to it on loopback without a proxy.

Wire shapes of docs/design.md that this client uses, as the server and this client have them:

- `POST usb/<name>/<op>` takes the parameter names of WebUSB (`configurationValue`,
  `interfaceNumber`, `alternateSetting`, `endpointNumber`, `direction`, `length`, and
  for a control transfer `requestType`, `recipient`, `request`, `value`, `index`),
  binary data as base64 in `data`, the timeout in ms in `timeout`. The answer is the
  result of the browser call: `{status, data}` for a transfer in and
  `{status, bytesWritten}` for a transfer out
- `POST usb/<name>/open` also takes `program`, the name of the calling program. The
  server keeps it as `holder` of the USB record and does not pass it to the browser
- `POST requests` answers the request record with `id`; `GET requests/<id>` answers
  it with `state` (`pending`, `granted`, `denied` or `expired`), `name` once granted
  and `error` once denied
- `GET settings-configs` answers `{configs: [...]}`: the system configs, then the user-saved ones;
  `POST settings-configs` saves one, `DELETE settings-configs/<token>` removes one
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

NAMESPACE = "jupyterlab-device-bridge-extension"

# How long `jupyter server list --json` may take, and how often the client asks it.
# A failure that is not the command's answer is tried again: a spike of load, or a
# package install rewriting the shared environment, makes it fail once and succeed the
# next time. A failure that stays is reported with its reason, never taken for a list
# with no server, because the fallback address then hides the reason and dials a port
# where nothing listens.
SERVER_LIST_TIMEOUT_S = 5
SERVER_LIST_ATTEMPTS = 3
SERVER_LIST_PAUSE_S = 1.0
# How long the server waits for the tab when the caller names no timeout (docs/design.md).
SERVER_TIMEOUT_S = 5.0
# What the HTTP call waits on top of the time the server may take.
HTTP_MARGIN_S = 5.0

REQUEST_TYPES = ("standard", "class", "vendor")
RECIPIENTS = ("device", "interface", "endpoint", "other")

# Requests to the local server bypass any proxy: urlopen follows http_proxy even for
# 127.0.0.1, and would hand the proxy the token and the bytes for the device.
_LOOPBACK = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class DeviceBridgeError(Exception):
    """An operation the bridge did not carry out.

    Attributes:
        status: HTTP status of the answer; None when the server gave no answer.
        message: The reason. For status 502 it is Chrome's own message.
        name: Chrome's error name for status 502 (for example `NetworkError`), or
            `stall` or `babble` for a transfer the device ended with that status.
        code: The error code of the bridge; None when the answer was not the bridge's.
    """

    def __init__(self, status: int | None, message: str, name: str | None = None,
                 code: str | None = None) -> None:
        super().__init__(f"{name}: {message}" if name else message)
        self.status = status
        self.message = message
        self.name = name
        self.code = code


def _server_list_once() -> tuple[list[dict] | None, str | None]:
    """What `jupyter server list --json` prints, or None and the reason it failed.

    An empty list is an answer: the command worked and no server is listed. A timeout,
    a missing command, a status other than 0 and a line that is not a record are not
    an answer, and the caller must not read them as a list with no server.
    """
    try:
        out = subprocess.run(
            ["jupyter", "server", "list", "--json"],
            capture_output=True, text=True, timeout=SERVER_LIST_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return None, f"`jupyter server list --json` did not finish in {SERVER_LIST_TIMEOUT_S} s"
    except FileNotFoundError:
        return None, "`jupyter` is not on PATH"
    except OSError as error:
        return None, f"`jupyter server list --json` could not start ({error})"
    if out.returncode != 0:
        last = (out.stderr.strip().splitlines() or [""])[-1]
        return None, (f"`jupyter server list --json` exited {out.returncode}"
                      + (f": {last}" if last else ""))
    records = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            return None, f"`jupyter server list --json` printed no server record: {line.strip()}"
    return records, None


def _listed_servers() -> list[dict]:
    """The records of the running servers: port, base_url and token.

    A failed command is tried again. A failure that stays is raised: a list nobody
    could read is not a list without the server, and the fallback address would hide
    the reason and dial a port where nothing listens.

    Raises:
        DeviceBridgeError: Every attempt failed; the message holds the last reason.
    """
    for attempt in range(SERVER_LIST_ATTEMPTS):
        if attempt:
            time.sleep(SERVER_LIST_PAUSE_S)
        records, reason = _server_list_once()
        if records is not None:
            return records
    raise DeviceBridgeError(
        None,
        f"{reason} - run `jupyter server list --json` in this shell to see the cause",
    )


def _ancestor_pids() -> set[int]:
    """The process ids on the parent chain of this process.

    The parent process id is field 4 of `/proc/<pid>/stat`, after the program name in
    parentheses and field 3, the state. The program name can hold spaces and brackets,
    so the fields are read after its last close parenthesis. The walk stops at 0 or 1
    and at an entry that cannot be read. Without `/proc` the set is empty, so the
    caller uses its other rules.
    """
    pids: set[int] = set()
    pid = os.getpid()
    while True:
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as stat:
                # Field 2, the program name, can hold spaces and brackets. Field 4, the
                # parent process id, follows field 3, the state, after its last bracket.
                fields = stat.read().rpartition(")")[2].split()
            pid = int(fields[1])
        except (OSError, IndexError, ValueError):
            break
        if pid <= 1:
            break
        pids.add(pid)
    return pids


def _server_list() -> dict:
    """The record of the server this program belongs to.

    The server that hosts this process is in its parent chain: a lab terminal and the
    programs started in it run below that server, while the runtime directory keeps
    records of other and older servers. That record wins over the listing order and
    the prefix. Without one, `jupyter server list` walks the runtime directory with
    os.listdir, so its order carries no meaning and the first entry is not a choice.
    `JUPYTERHUB_SERVICE_PREFIX` names this process's server. Without that variable one
    listed server is unambiguous; with it, a record the prefix disowns is not used.
    Several with no match are not: guessing lands the devices, the run and the shell
    command in another lab, so the caller gets the list instead.
    """
    records = _listed_servers()
    ancestors = _ancestor_pids()
    for record in records:
        try:
            if int(record.get("pid")) in ancestors:
                return record
        except (TypeError, ValueError):
            # A record without a pid, or with a pid that is no number, names no
            # process, so it cannot host this one.
            continue
    prefix = os.environ.get("JUPYTERHUB_SERVICE_PREFIX")
    if prefix:
        wanted = prefix.rstrip("/") + "/"
        for record in records:
            if record.get("base_url", "/") == wanted:
                return record
    if len(records) == 1 and not prefix:
        return records[0]
    if len(records) > 1:
        listed = ", ".join(f"{record.get('port')}{record.get('base_url', '/')}" for record in records)
        raise DeviceBridgeError(
            None,
            f"{len(records)} Jupyter servers are listed and none is this lab's: {listed} - "
            "remove the stale records, or set JUPYTERHUB_SERVICE_PREFIX to the lab's base path",
        )
    return {}


def _base_url(info: dict) -> str:
    """Where the server answers, always on loopback."""
    if info:
        scheme = "https" if info.get("secure") else "http"
        return f"{scheme}://127.0.0.1:{info.get('port', 8888)}{info.get('base_url', '/').rstrip('/')}"
    port = os.environ.get("JUPYTER_PORT") or "8888"
    return f"http://127.0.0.1:{port}{os.environ.get('JUPYTERHUB_SERVICE_PREFIX', '').rstrip('/')}"


def _token(info: dict) -> str | None:
    """The token that authenticates to that server.

    The hub token wins: under JupyterHub the server refuses its own listed token.
    The listed token then outranks JUPYTER_TOKEN, which can be a stale export.
    """
    hub = os.environ.get("JUPYTERHUB_API_TOKEN") or os.environ.get("JPY_API_TOKEN")
    if hub:
        return hub
    # `in`, not truthiness: a listed token "" means the server wants none.
    if "token" in info:
        return info["token"] or None
    return os.environ.get("JUPYTER_TOKEN") or None


def _error_from(error: urllib.error.HTTPError, url: str) -> DeviceBridgeError:
    """The bridge's error envelope `{error: {code, message, name?}}` as an exception."""
    try:
        detail = json.loads(error.read())["error"]
        return DeviceBridgeError(error.code, detail["message"], detail.get("name"), detail["code"])
    except (ValueError, KeyError, TypeError, AttributeError):
        # Not the bridge's answer: a server without the extension, or a refused token.
        return DeviceBridgeError(error.code, f"{error.code} {error.reason} from {url}")


class DeviceBridgeClient:
    """The device bridge of one Jupyter server.

    Args:
        base_url: Address of the server, for example `http://127.0.0.1:8888`. When
            omitted, the server and its token are found as the CLI finds them:
            `jupyter server list --json`, the hub token first, then the listed
            token, then `JUPYTER_TOKEN`.
        token: The server's token; used only together with `base_url`.
        program: The name the bridge shows for this program: in a device request and
            as the holder of a USB device it opened. The name of the running
            program when omitted.
    """

    def __init__(self, base_url: str | None = None, token: str | None = None,
                 program: str | None = None) -> None:
        if base_url is None:
            info = _server_list()
            base_url, token = _base_url(info), _token(info)
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.program = program or os.path.basename(sys.argv[0]) or "python"

    def call(self, method: str, path: str, body: dict | None = None,
             query: dict | None = None, timeout: float = SERVER_TIMEOUT_S + HTTP_MARGIN_S) -> dict:
        """Send one request to the bridge and return its JSON answer.

        Args:
            method: HTTP method.
            path: Path below the bridge's namespace, for example `devices`.
            body: JSON body.
            query: Query parameters.
            timeout: Seconds to wait for the answer.

        Raises:
            DeviceBridgeError: The server refused, or gave no answer.
        """
        url = f"{self.base_url}/{NAMESPACE}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"token {self.token}"
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with _LOOPBACK.open(request, timeout=timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            raise _error_from(error, url) from None
        except OSError as error:
            # URLError is an OSError, and so are the timeout and the reset that the
            # read phase raises bare.
            reason = getattr(error, "reason", error)
            raise DeviceBridgeError(
                None,
                f"cannot reach the Jupyter server at {self.base_url} ({reason})"
                " - start JupyterLab, or run this command in a terminal of the lab",
            ) from None

    def status(self) -> dict:
        """Version, connected tabs, device directory and shim directory of the bridge."""
        return self.call("GET", "status")

    def devices(self) -> dict:
        """The device table: `{serial: [record, ...], usb: [record, ...]}`."""
        return self.call("GET", "devices")

    def configs(self) -> list[dict]:
        """The serial settings configs: the system configs and the user-saved ones."""
        return self.call("GET", "settings-configs")["configs"]

    def save_config(self, name: str, values: dict) -> dict:
        """Save five settings under a user name; returns the saved config."""
        return self.call("POST", "settings-configs", {"name": name, **values})

    def delete_config(self, token: str) -> dict:
        """Delete a user-saved config; a system config is refused."""
        return self.call("DELETE", f"settings-configs/{urllib.parse.quote(token, safe='')}")

    def serial(self, name: str) -> "SerialDevice":
        """The serial device with this name, for example `tty-2341-0043`."""
        return SerialDevice(self, name)

    def usb(self, name: str) -> "UsbDevice":
        """The USB device with this name, for example `usb-0483-3748`."""
        return UsbDevice(self, name)

    def request_device(self, kind: str, reason: str, vendor_id: int | None = None,
                       product_id: int | None = None, program: str | None = None) -> dict:
        """Ask the user to grant a device that is not attached yet.

        Args:
            kind: `serial` or `usb`.
            reason: Shown to the user next to the Grant button.
            vendor_id: USB vendor id that Chrome's dialog is filtered to.
            product_id: USB product id that Chrome's dialog is filtered to.
            program: Who asks; the program name of this client when omitted.

        Returns:
            The request record with its `id`; poll it with `request_state`.
        """
        body = {"kind": kind, "reason": reason, "program": program or self.program}
        if vendor_id is not None:
            body["vendorId"] = vendor_id
        if product_id is not None:
            body["productId"] = product_id
        return self.call("POST", "requests", body)

    def request_state(self, request_id: str, wait: float = 0.0) -> dict:
        """The request record; with `wait` the server answers when it changes or the time ends."""
        return self.call("GET", f"requests/{urllib.parse.quote(str(request_id), safe='')}",
                         query={"wait": wait}, timeout=wait + HTTP_MARGIN_S)


class SerialDevice:
    """One serial port of the bridge. Programs open its `path`; this object is the rest."""

    def __init__(self, client: DeviceBridgeClient, name: str) -> None:
        self.name = name
        self._client = client
        self._path = f"serial/{urllib.parse.quote(name, safe='')}"

    def record(self) -> dict:
        """The device record: `path`, `state`, `holder`, `settings`, `configured` and the rest.

        Raises:
            DeviceBridgeError: Status 404 when the bridge lists no such serial device.
        """
        for record in self._client.devices()["serial"]:
            if record["name"] == self.name:
                return record
        raise DeviceBridgeError(404, f"no serial device named {self.name}", code="unknown-device")

    def set_settings(self, **change: object) -> dict:
        """Apply a saved config (`config`) or single fields: `baudRate`, `dataBits`, `parity`, `stopBits`, `onOpen`.

        Returns:
            The device record after the change.
        """
        return self._client.call("PUT", f"{self._path}/settings", change)

    def monitor(self, since: int = 0, wait: float = 0.0) -> dict:
        """Bytes the port sent, from the server's buffer.

        Args:
            since: Absolute byte offset to read from; 0 reads everything still kept.
            wait: Seconds the server may hold the call until new bytes arrive.

        Returns:
            `{data: bytes, start, next, dropped}`; pass `next` as the next `since`.
        """
        answer = self._client.call("GET", f"{self._path}/monitor",
                                   query={"since": since, "wait": wait},
                                   timeout=wait + SERVER_TIMEOUT_S + HTTP_MARGIN_S)
        answer["data"] = base64.b64decode(answer["data"])
        return answer

    def write(self, data: bytes) -> None:
        """Send bytes to the port."""
        self._client.call("POST", f"{self._path}/write",
                          {"data": base64.b64encode(data).decode()})

    def signals(self, dtr: bool | None = None, rts: bool | None = None,
                brk: bool | None = None) -> None:
        """Set the control lines that are not None."""
        lines = {"dtr": dtr, "rts": rts, "brk": brk}
        self._client.call("POST", f"{self._path}/signals",
                          {line: state for line, state in lines.items() if state is not None})

    def action(self, action: str) -> None:
        """Run one action on the port: `pulse-dtr`, `pulse-rts`, `esp-bootloader`, `touch-1200` or `none`."""
        self._client.call("POST", f"{self._path}/action", {"action": action})


class UsbDevice:
    """One USB device of the bridge, with one method per WebUSB operation.

    A transfer the device ends with `stall` or `babble` raises `DeviceBridgeError`
    with that word as its `name`.
    """

    def __init__(self, client: DeviceBridgeClient, name: str) -> None:
        self.name = name
        self._client = client
        self._path = f"usb/{urllib.parse.quote(name, safe='')}"

    def _op(self, op: str, timeout_ms: int | None = None, **args: object) -> dict:
        """Run one operation in the browser and return its result."""
        wait = timeout_ms / 1000 if timeout_ms else SERVER_TIMEOUT_S
        if timeout_ms:
            args["timeout"] = timeout_ms
        result = self._client.call("POST", f"{self._path}/{op}", args, timeout=wait + HTTP_MARGIN_S)
        status = result.get("status", "ok")
        if status != "ok":
            raise DeviceBridgeError(200, f"the device ended {op} with {status}", name=status)
        return result

    def describe(self) -> dict:
        """The descriptors: configurations, interfaces, endpoints and strings."""
        return self._client.call("GET", self._path)

    def open(self) -> None:
        """Open the device in the browser; the bridge lists this program as its holder."""
        self._op("open", program=self._client.program)

    def close(self) -> None:
        """Close the device in the browser."""
        self._op("close")

    def reset(self) -> None:
        """Reset the device."""
        self._op("reset")

    def select_configuration(self, configuration_value: int) -> None:
        """Select the configuration with this `bConfigurationValue`."""
        self._op("select-configuration", configurationValue=configuration_value)

    def claim_interface(self, interface_number: int) -> None:
        """Claim an interface for this lab tab."""
        self._op("claim-interface", interfaceNumber=interface_number)

    def release_interface(self, interface_number: int) -> None:
        """Release a claimed interface."""
        self._op("release-interface", interfaceNumber=interface_number)

    def select_alternate(self, interface_number: int, alternate_setting: int) -> None:
        """Select an alternate setting of a claimed interface."""
        self._op("select-alternate", interfaceNumber=interface_number,
                 alternateSetting=alternate_setting)

    def clear_halt(self, direction: str, endpoint_number: int) -> None:
        """Clear the halt of an endpoint; `direction` is `in` or `out`."""
        self._op("clear-halt", direction=direction, endpointNumber=endpoint_number)

    def control_in(self, request_type: str, recipient: str, request: int, value: int,
                   index: int, length: int, timeout_ms: int | None = None) -> bytes:
        """Control transfer from the device; returns the bytes it sent.

        Args:
            request_type: `standard`, `class` or `vendor`.
            recipient: `device`, `interface`, `endpoint` or `other`.
            request: bRequest.
            value: wValue.
            index: wIndex.
            length: Most bytes to read.
            timeout_ms: Milliseconds the bridge waits for the browser.
        """
        result = self._op("control-in", timeout_ms, requestType=request_type, recipient=recipient,
                          request=request, value=value, index=index, length=length)
        return base64.b64decode(result.get("data", ""))

    def control_out(self, request_type: str, recipient: str, request: int, value: int,
                    index: int, data: bytes = b"", timeout_ms: int | None = None) -> int:
        """Control transfer to the device; returns the number of bytes written."""
        result = self._op("control-out", timeout_ms, requestType=request_type, recipient=recipient,
                          request=request, value=value, index=index,
                          data=base64.b64encode(data).decode())
        return result.get("bytesWritten", len(data))

    def control(self, bm_request_type: int, request: int, value: int, index: int,
                data_or_length: bytes | int, timeout_ms: int | None = None) -> bytes | int:
        """Control transfer described by a `bmRequestType` byte, as libusb and pyusb do.

        Bit 7 set reads `data_or_length` bytes and returns them; bit 7 clear writes
        the bytes in `data_or_length` and returns how many were written.
        """
        request_type = REQUEST_TYPES[(bm_request_type >> 5) & 3]
        recipient = RECIPIENTS[bm_request_type & 3]
        if bm_request_type & 0x80:
            return self.control_in(request_type, recipient, request, value, index,
                                   data_or_length, timeout_ms)
        return self.control_out(request_type, recipient, request, value, index,
                                data_or_length, timeout_ms)

    def transfer_in(self, endpoint_number: int, length: int, timeout_ms: int | None = None) -> bytes:
        """Bulk or interrupt transfer from the device; returns the bytes it sent."""
        result = self._op("transfer-in", timeout_ms, endpointNumber=endpoint_number, length=length)
        return base64.b64decode(result.get("data", ""))

    def transfer_out(self, endpoint_number: int, data: bytes, timeout_ms: int | None = None) -> int:
        """Bulk or interrupt transfer to the device; returns the number of bytes written."""
        result = self._op("transfer-out", timeout_ms, endpointNumber=endpoint_number,
                          data=base64.b64encode(data).decode())
        return result.get("bytesWritten", len(data))
