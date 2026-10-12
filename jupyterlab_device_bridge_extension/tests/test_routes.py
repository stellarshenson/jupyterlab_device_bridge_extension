"""Tests of the REST API and of the WebSocket's door: authentication, names, input, answers."""

import asyncio
import base64
import json
import os
import time

import pytest
import tornado.httpclient
import tornado.web
import tornado.websocket

from jupyterlab_device_bridge_extension import __version__, manager as manager_module
from jupyterlab_device_bridge_extension.profiles import PROFILES
from jupyterlab_device_bridge_extension.routes import NAMESPACE, BridgeHandler
from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_NAME, USB_NAME

# Every HTTP route of the bridge: its handler, its verb and one path of it.
ROUTES = [
    ("StatusHandler", "GET", "status"),
    ("DevicesHandler", "GET", "devices"),
    ("ProfilesHandler", "GET", "profiles"),
    ("SerialProfileHandler", "PUT", f"serial/{SERIAL_NAME}/profile"),
    ("SerialMonitorHandler", "GET", f"serial/{SERIAL_NAME}/monitor"),
    ("SerialCommandHandler", "POST", f"serial/{SERIAL_NAME}/write"),
    ("SerialCommandHandler", "POST", f"serial/{SERIAL_NAME}/signals"),
    ("SerialCommandHandler", "POST", f"serial/{SERIAL_NAME}/action"),
    ("RequestsHandler", "GET", "requests"),
    ("RequestsHandler", "POST", "requests"),
    ("RequestHandler", "GET", "requests/abcd1234"),
    ("UsbHandler", "GET", f"usb/{USB_NAME}"),
    ("UsbOperationHandler", "POST", f"usb/{USB_NAME}/open"),
]
# Paths that take a device name, with the place of the name left open.
NAMED = [
    ("PUT", "serial/{}/profile"),
    ("GET", "serial/{}/monitor"),
    ("POST", "serial/{}/write"),
    ("POST", "serial/{}/signals"),
    ("POST", "serial/{}/action"),
    ("GET", "usb/{}"),
    ("POST", "usb/{}/open"),
]
BAD_NAMES = ["..", "..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "tty%2F..%2F..", "..%2Ftty-2341-0043",
             "TTY-2341-0043", "tty_2341", "tty.2341", "tty%202341", "tty-2341-0043%0A", "t" * 65]
# A cookie and the same value in a header, which any client can make up. Jupyter Server
# refuses a PUT or a POST that has neither a token nor this pair in its XSRF check,
# before the decorator of the handler is asked. With the pair the request passes that
# check, and only the decorator is left to refuse it.
_XSRF = "0123456789abcdef0123456789abcdef"
XSRF_PAIR = {"Cookie": f"_xsrf={_XSRF}", "X-XSRFToken": _XSRF}


@pytest.fixture
def jp_server_config(jp_server_config):
    """The server of these tests admits a request without credentials to any endpoint that is not marked.

    That is the default of Jupyter Server. So what refuses a request here is the
    decorator on the bridge's own handler, and a handler without one fails its test.
    """
    jp_server_config["ServerApp"]["allow_unauthenticated_access"] = True
    return jp_server_config


def record(tab, name=SERIAL_NAME):
    return next(device for device in tab.devices["serial"] if device["name"] == name)


async def attach(fake_tab):
    """A connected tab that holds the serial port."""
    tab = await fake_tab()
    assert (await tab.claim_serial())["ok"]
    # The device table that lists the port arrives after the answer to the claim.
    await tab.until(lambda: any(
        device["name"] == SERIAL_NAME and device["portState"] == "open"
        for device in tab.devices["serial"]))
    return tab


@pytest.fixture
def raw(http_server_client, jp_base_url, jp_auth_header):
    """Fetch a path of the bridge exactly as written, with or without credentials: `(status, body)`."""
    async def fetch(method, path, headers=jp_auth_header):
        try:
            response = await http_server_client.fetch(
                f"{jp_base_url}{NAMESPACE}/{path}", method=method, headers=headers,
                body=None if method == "GET" else "{}")
        except tornado.httpclient.HTTPClientError as error:
            response = error.response
        return response.code, response.body

    return fetch


def tree(directory):
    """Every path under a directory."""
    return sorted(os.path.join(root, name) for root, directories, files in os.walk(directory)
                  for name in directories + files)


# ----------------------------------------------------------------------- authentication


def test_acc_sec_91_the_route_table_of_this_test_is_complete():
    """ACC-SEC-91 the routes that the authentication test asks are all the verbs of all REST handlers."""
    verbs = {(handler.__name__, verb)
             for handler in BridgeHandler.__subclasses__()
             for verb in tornado.web.RequestHandler.SUPPORTED_METHODS
             if verb.lower() in vars(handler)}

    assert {(handler, verb) for handler, verb, _ in ROUTES} == verbs


@pytest.mark.parametrize("handler, method, path", ROUTES)
async def test_acc_sec_91_every_http_route_refuses_a_request_without_credentials(
        handler, method, path, raw, fake_tab):
    """ACC-SEC-91 every HTTP endpoint answers 403 to a request without a token and to one with a wrong token, also when the request passes the XSRF check."""
    tab = await attach(fake_tab)
    assert (await tab.claim_usb())["ok"]

    assert (await raw(method, path, headers={}))[0] == 403
    assert (await raw(method, path, headers=XSRF_PAIR))[0] == 403
    wrong_token = {**XSRF_PAIR, "Authorization": "token not-the-server-token"}
    assert (await raw(method, path, headers=wrong_token))[0] == 403
    assert [event for event in tab.events if event["type"].startswith(("serial-", "usb"))] == []
    # The same request with the server's token passes the door: 200, or 400 or 404 for its empty body.
    assert (await raw(method, path))[0] in (200, 400, 404)


async def test_acc_sec_92_the_websocket_refuses_a_connection_without_credentials(
        http_server, jp_http_port, jp_base_url, jp_auth_header):
    """ACC-SEC-92 the WebSocket handshake is refused without a token and with a wrong token."""
    url = f"ws://127.0.0.1:{jp_http_port}{jp_base_url}{NAMESPACE}/ws"

    def connect(headers):
        return tornado.websocket.websocket_connect(tornado.httpclient.HTTPRequest(url, headers=headers))

    for headers in ({}, {"Authorization": "token not-the-server-token"}):
        with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
            await connect(headers)
        assert refused.value.code == 403

    accepted = await connect(jp_auth_header)
    accepted.close()


# ------------------------------------------------------------------------------- names


@pytest.mark.parametrize("name", BAD_NAMES)
async def test_acc_sec_96_a_name_outside_the_pattern_is_refused_before_any_file_is_touched(
        name, raw, fake_tab, device_dir):
    """ACC-SEC-96 a device name outside the pattern is answered 400 on every route that takes a name, and no file changes."""
    tab = await attach(fake_tab)
    assert (await tab.claim_usb())["ok"]
    before = tree(os.path.dirname(device_dir))

    for method, path in NAMED:
        status, body = await raw(method, path.format(name))
        assert status == 400, f"{method} {path.format(name)} answered {status}"
        assert json.loads(body)["error"]["code"] == "invalid-name"

    assert tree(os.path.dirname(device_dir)) == before
    assert tab.got("serial-write") == [] and tab.got("serial-signals") == [] and tab.usb_calls == []


async def test_acc_sec_96_an_unknown_name_inside_the_pattern_is_404(api, fake_tab):
    """ACC-SEC-96 a name inside the pattern that no device has is answered 404 with the code unknown-device."""
    await attach(fake_tab)

    for method, path in NAMED:
        status, document = await api(method, *path.format("tty-0000-0000").split("/"))
        assert (status, document["error"]["code"]) == (404, "unknown-device")
        assert "tty-0000-0000" in document["error"]["message"]
    assert (await api("GET", "usb", SERIAL_NAME))[0] == 404, "a serial device is no USB device"


# -------------------------------------------------------------- status, table, profiles


async def test_acc_serial_15_status_lists_tabs_round_trip_directories_and_counts(api, fake_tab, device_dir):
    """ACC-SERIAL-15 (server half) status has the version, the tabs with their interfaces and round trip, both directories and the counts."""
    status, document = await api("GET", "status")
    assert (status, document) == (200, {
        "version": __version__, "deviceDir": device_dir, "shimDir": os.path.join(device_dir, ".shim"),
        "tabs": [], "counts": {"serial": 0, "usb": 0, "requests": 0}})

    tab = await attach(fake_tab)
    await tab.claim_usb()
    await api("POST", "requests", body={"kind": "usb", "reason": "flash", "program": "pytest"})
    await tab.send({"type": "ping", "t": 1234.5})
    await tab.until(lambda: tab.got("pong"))
    assert tab.got("pong") == [{"type": "pong", "t": 1234.5}]

    for _ in range(100):
        status, document = await api("GET", "status")
        if document["tabs"][0]["roundTrip"] is not None:
            break
        await asyncio.sleep(0.01)
    assert document["counts"] == {"serial": 1, "usb": 1, "requests": 1}
    (listed,) = document["tabs"]
    assert (listed["tabId"], listed["serial"], listed["usb"]) == ("tab-1", True, True)
    assert isinstance(listed["roundTrip"], float) and 0 <= listed["roundTrip"] < 1000


async def test_acc_prof_22_the_profiles_route_lists_the_built_in_profiles(api, fake_tab):
    """ACC-PROF-22 `GET profiles` and the tab's welcome carry the five built-in profiles."""
    status, document = await api("GET", "profiles")

    assert (status, document) == (200, {"profiles": PROFILES})
    assert len(document["profiles"]) == 5
    assert (await fake_tab()).welcome["profiles"] == PROFILES


async def test_acc_serial_3_the_device_table_has_every_field_of_the_design(api, fake_tab, device_dir):
    """ACC-SERIAL-3 `GET devices` answers the serial and the USB record of the design, equal to the table the tabs get."""
    tab = await attach(fake_tab)
    await tab.claim_usb()
    await tab.send({"type": "stats", "name": USB_NAME, "rx": 3, "tx": 4})
    await tab.until(lambda: tab.devices["usb"] and tab.devices["usb"][0]["rx"] == 3)

    status, table = await api("GET", "devices")

    assert status == 200
    assert table["serial"] == [{
        "name": SERIAL_NAME, "path": os.path.join(device_dir, SERIAL_NAME), "state": "attached",
        "portState": "open", "tab": "tab-1", "holder": None,
        "settings": {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1},
        "profile": "monitor", "overrides": {}, "signals": {}, "rx": 0, "tx": 0,
        "vendorId": 0x2341, "productId": 0x0043, "error": None}]
    assert table["usb"] == [{
        "name": USB_NAME, "state": "attached", "tab": "tab-1", "vendorId": 0xCAFE, "productId": 0x4001,
        "productName": "Loopback", "manufacturerName": "Simulated Devices", "serialNumber": "SN0001",
        "opened": False, "holder": None, "rx": 3, "tx": 4, "error": None}]
    assert {"serial": table["serial"], "usb": table["usb"]} == {
        "serial": tab.devices["serial"], "usb": tab.devices["usb"]}


# ---------------------------------------------------------------------------- profiles


async def test_acc_prof_23_a_profile_change_reaches_the_record_and_the_port(api, fake_tab):
    """ACC-PROF-23 a profile set through the route is in the device record and the port is reopened with its settings."""
    tab = await attach(fake_tab)

    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "stm32-bootloader"})

    assert (status, changed["profile"], changed["overrides"]) == (200, "stm32-bootloader", {})
    assert changed["settings"] == {"baudRate": 115200, "dataBits": 8, "parity": "even", "stopBits": 1}
    await tab.until(lambda: tab.got("serial-configure"))
    assert tab.got("serial-configure")[-1]["settings"] == changed["settings"]
    await tab.until(lambda: record(tab)["profile"] == "stm32-bootloader")


async def test_acc_prof_24_single_fields_override_the_profile(api, fake_tab):
    """ACC-PROF-24 single fields override the profile, a profile id clears the overrides, and both work on a detached device."""
    tab = await attach(fake_tab)

    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile",
                                body={"profile": "arduino-upload", "baudRate": 57600})
    assert (changed["profile"], changed["overrides"]) == ("arduino-upload", {"baudRate": 57600})
    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile",
                                body={"parity": "odd", "dataBits": 7, "stopBits": 2, "onOpen": "none"})
    assert changed["overrides"] == {"baudRate": 57600, "parity": "odd", "dataBits": 7, "stopBits": 2,
                                    "onOpen": "none"}
    assert changed["settings"] == {"baudRate": 57600, "dataBits": 7, "parity": "odd", "stopBits": 2}
    await tab.until(lambda: tab.settings[SERIAL_NAME] == changed["settings"])

    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")
    status, changed = await api("PUT", "serial", SERIAL_NAME, "profile", body={"profile": "arduino-isp"})
    assert (status, changed["overrides"], changed["settings"]["baudRate"]) == (200, {}, 19200)
    claimed = await tab.claim_serial()
    assert (claimed["profile"], claimed["settings"]) == ("arduino-isp", changed["settings"])


@pytest.mark.parametrize("body, field", [
    ({"profile": "arduino"}, "profile"),
    ({"onOpen": "pulse-cts"}, "onOpen"),
    ({"parity": "mark"}, "parity"),
    ({"dataBits": 9}, "dataBits"),
    ({"stopBits": 3}, "stopBits"),
    ({"baudRate": 0}, "baudRate"),
    ({"baudRate": "fast"}, "baudRate"),
    ({"profile": "esp-upload", "parity": "space"}, "parity"),
    ({"speed": 9600}, "speed"),
])
async def test_acc_prof_32_invalid_profile_input_is_400_and_names_the_field(body, field, api, fake_tab):
    """ACC-PROF-32 an unknown profile id, action, parity or bit count is refused with status 400 and a message naming the field."""
    tab = await attach(fake_tab)
    before = record(tab)

    status, document = await api("PUT", "serial", SERIAL_NAME, "profile", body=body)

    assert (status, document["error"]["code"]) == (400, "bad-profile")
    assert document["error"]["message"].startswith(f"{field}: ")
    assert (await api("GET", "devices"))[1]["serial"] == [before], "a refused change changed the device"
    assert tab.got("serial-configure") == []


async def test_acc_prof_32_a_body_that_is_not_a_json_object_is_400(raw, jp_auth_header, http_server_client,
                                                                   jp_base_url, fake_tab):
    """ACC-PROF-32 a body that is not one JSON object is refused with status 400."""
    await attach(fake_tab)
    url = f"{jp_base_url}{NAMESPACE}/serial/{SERIAL_NAME}/profile"

    for body in ("[1, 2]", "not json", '"monitor"'):
        with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
            await http_server_client.fetch(url, method="PUT", headers=jp_auth_header, body=body)
        assert refused.value.code == 400
        assert json.loads(refused.value.response.body)["error"]["code"] == "bad-request"


# ----------------------------------------------------------------------------- monitor


async def test_acc_mon_39_bytes_the_port_sent_before_the_call_are_returned(api, fake_tab):
    """ACC-MON-39 the monitor route returns bytes the port sent before the call, also after the port was detached."""
    tab = await attach(fake_tab)
    await tab.port_sends(SERIAL_NAME, b"boot\n")
    await tab.port_sends(SERIAL_NAME, b"\x00\xffready\n")

    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)
    while chunk["next"] < 13:
        status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)
    assert (status, base64.b64decode(chunk["data"])) == (200, b"boot\n\x00\xffready\n")
    assert (chunk["start"], chunk["next"], chunk["dropped"]) == (0, 13, False)

    await tab.release(SERIAL_NAME, "removed")
    await tab.until(lambda: record(tab)["state"] == "detached")
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", since=5)
    assert (status, base64.b64decode(chunk["data"]), chunk["start"]) == (200, b"\x00\xffready\n", 5)


async def test_acc_mon_42_the_monitor_route_waits_for_new_bytes(api, fake_tab):
    """ACC-MON-42 with `wait` the monitor route returns when new bytes arrive, or with no bytes when the time ends."""
    tab = await attach(fake_tab)
    await tab.port_sends(SERIAL_NAME, b"old")
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)
    assert chunk["next"] == 3

    asyncio.get_running_loop().call_later(
        0.2, lambda: asyncio.ensure_future(tab.port_sends(SERIAL_NAME, b"new")))
    started = time.monotonic()
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", since=3, wait=10)
    assert (base64.b64decode(chunk["data"]), chunk["start"], chunk["next"]) == (b"new", 3, 6)
    assert 0.15 < time.monotonic() - started < 5

    started = time.monotonic()
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", since=6, wait=0.3)
    assert (status, chunk) == (200, {"data": "", "start": 6, "next": 6, "dropped": False})
    assert 0.25 < time.monotonic() - started < 3


async def test_acc_mon_40_the_configured_buffer_size_bounds_the_monitor(api, fake_tab, manager):
    """ACC-MON-40 the monitor of a port keeps `monitor_bytes` bytes and reports older bytes as dropped."""
    assert manager.monitor_bytes == 262144, "the default of the setting DeviceBridge.monitor_bytes"
    manager.monitor_bytes = 100
    tab = await attach(fake_tab)
    data = bytes(range(250))

    await tab.port_sends(SERIAL_NAME, data)
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)

    assert base64.b64decode(chunk["data"]) == data[150:]
    assert (chunk["start"], chunk["next"], chunk["dropped"]) == (150, 250, True)


@pytest.mark.parametrize("query", [{"since": "-1"}, {"since": "abc"}, {"since": "1.5"}, {"wait": "-1"},
                                   {"wait": "soon"}, {"wait": "nan"}, {"wait": "inf"}])
async def test_acc_mon_42_a_malformed_offset_or_wait_is_400(query, api, fake_tab):
    """ACC-MON-42 an offset or a wait that is not a number of 0 or more is refused with status 400."""
    await attach(fake_tab)

    status, document = await api("GET", "serial", SERIAL_NAME, "monitor", **query)

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith(f"{next(iter(query))}: ")


# ---------------------------------------------------------- write, signals and actions


async def test_acc_mon_43_the_write_route_sends_the_bytes_to_the_port(api, fake_tab):
    """ACC-MON-43 the bytes of `POST write` reach the port unchanged, and the port's echo is in the monitor."""
    tab = await attach(fake_tab)
    data = bytes(range(256))

    status, document = await api("POST", "serial", SERIAL_NAME, "write",
                                 body={"data": base64.b64encode(data).decode()})

    assert (status, document) == (200, {})
    assert tab.written(SERIAL_NAME) == data
    assert [event["name"] for event in tab.got("serial-write")] == [SERIAL_NAME]
    status, chunk = await api("GET", "serial", SERIAL_NAME, "monitor", wait=5)
    assert base64.b64decode(chunk["data"]) == data


async def test_acc_prof_26_signals_and_actions_by_hand_reach_the_tab(api, fake_tab):
    """ACC-PROF-26 (by hand) `POST signals` sets the named control lines and `POST action` runs one action on the port."""
    tab = await attach(fake_tab)

    assert await api("POST", "serial", SERIAL_NAME, "signals", body={"dtr": False, "rts": True}) == (200, {})
    assert await api("POST", "serial", SERIAL_NAME, "signals", body={"brk": True}) == (200, {})
    assert await api("POST", "serial", SERIAL_NAME, "action", body={"action": "esp-bootloader"}) == (200, {})

    signals = [{key: value for key, value in event.items() if key not in ("type", "seq", "name")}
               for event in tab.got("serial-signals")]
    assert signals == [{"dtr": False, "rts": True}, {"brk": True}]
    assert [event["action"] for event in tab.got("serial-action")] == ["esp-bootloader"]
    await tab.until(lambda: record(tab)["signals"] == {"dtr": False, "rts": True, "brk": True})


@pytest.mark.parametrize("command, body, field", [
    ("write", {}, "data"),
    ("write", {"data": 5}, "data"),
    ("write", {"data": "not base64!"}, "data"),
    ("signals", {}, "signals"),
    ("signals", {"dtr": 1}, "signals"),
    ("signals", {"cts": True}, "signals"),
    ("action", {}, "action"),
    ("action", {"action": "explode"}, "action"),
    ("action", {"action": ["pulse-dtr"]}, "action"),
])
async def test_acc_prof_32_malformed_command_input_is_400(command, body, field, api, fake_tab):
    """ACC-PROF-32 a write without base64 data, a signal that is not true or false and an unknown action are refused with status 400."""
    tab = await attach(fake_tab)

    status, document = await api("POST", "serial", SERIAL_NAME, command, body=body)

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith(f"{field}: ")
    assert [event for event in tab.events if event["type"].startswith("serial-")] == []


# ------------------------------------------------------------------------ error answers


async def test_acc_cli_84_a_command_for_a_detached_device_is_409(api, fake_tab):
    """ACC-CLI-84 (server half) a command for a detached device is answered 409: with the code detached while a tab is connected, with no-tab while none is."""
    tab = await attach(fake_tab)
    await tab.release(SERIAL_NAME)
    await tab.until(lambda: record(tab)["state"] == "detached")

    status, document = await api("POST", "serial", SERIAL_NAME, "write", body={"data": "AA=="})
    assert (status, document["error"]["code"]) == (409, "detached")
    assert document["error"]["message"] == f"{SERIAL_NAME} is detached: no lab tab holds it"

    await tab.close()
    for _ in range(200):
        if not (await api("GET", "status"))[1]["tabs"]:
            break
        await asyncio.sleep(0.01)
    status, document = await api("POST", "serial", SERIAL_NAME, "action", body={"action": "pulse-dtr"})
    assert (status, document["error"]["code"]) == (409, "no-tab")
    assert document["error"]["message"] == f"{SERIAL_NAME} is detached: no lab tab is connected"


async def test_acc_mon_43_a_command_the_browser_refuses_is_502_with_its_name_and_message(api, fake_tab):
    """ACC-MON-43 (edge) a serial command the browser refuses is answered 502 with the browser's error name and message."""
    tab = await attach(fake_tab)
    tab.error = ("NetworkError", "The device has been lost.")

    status, document = await api("POST", "serial", SERIAL_NAME, "signals", body={"dtr": True})

    assert status == 502
    assert document == {"error": {"code": "browser", "name": "NetworkError",
                                  "message": "The device has been lost."}}


async def test_acc_mon_43_a_command_the_tab_does_not_answer_is_504(api, fake_tab, manager):
    """ACC-MON-43 (edge) a serial command the tab does not ack within the timeout is answered 504."""
    manager.command_timeout = 0.3
    tab = await attach(fake_tab)
    tab.answers = False

    started = time.monotonic()
    status, document = await api("POST", "serial", SERIAL_NAME, "write", body={"data": "AA=="})

    assert (status, document) == (504, {"error": {"code": "timeout",
                                                  "message": "the tab did not answer in time"}})
    assert 0.25 < time.monotonic() - started < 3
    assert len(tab.got("serial-write")) == 1


# ---------------------------------------------------------------------- device requests


async def test_acc_usb_47_a_device_request_is_listed_and_sent_to_every_tab(api, fake_tab):
    """ACC-USB-47 a posted device request is pending, has an id, and reaches every tab with program, ids and reason."""
    tab = await fake_tab("tab-1")
    posted = {"kind": "usb", "vendorId": 0x0483, "productId": 0x3748,
              "reason": "flash through the ST-Link", "program": "jupyterlab-device"}

    status, request = await api("POST", "requests", body=posted)

    assert status == 200 and request == {**posted, "id": request["id"], "state": "pending"}
    await tab.until(lambda: tab.requests["pending"])
    assert tab.requests == {"type": "requests", "pending": [{**posted, "id": request["id"]}]}
    late = await fake_tab("tab-2")
    assert late.requests == tab.requests, "a tab that connects later gets the pending requests"
    assert (await api("GET", "requests")) == (200, {"requests": [request]})
    assert (await api("GET", "requests", request["id"])) == (200, request)


async def test_acc_usb_48_a_granted_request_ends_with_the_device_name(api, fake_tab):
    """ACC-USB-48 the tab's `request-result` ends a request as granted with the device's name; a waiting caller gets it at once."""
    tab = await fake_tab()
    status, request = await api("POST", "requests",
                                body={"kind": "serial", "reason": "upload", "program": "pytest"})
    asyncio.get_running_loop().call_later(0.2, lambda: asyncio.ensure_future(tab.send(
        {"type": "request-result", "id": request["id"], "ok": True, "name": SERIAL_NAME})))

    started = time.monotonic()
    status, answered = await api("GET", "requests", request["id"], wait=10)

    assert 0.15 < time.monotonic() - started < 5
    assert (status, answered) == (200, {**request, "state": "granted", "name": SERIAL_NAME})
    await tab.until(lambda: tab.requests["pending"] == [])
    assert (await api("GET", "status"))[1]["counts"]["requests"] == 0


async def test_acc_usb_49_a_refused_request_ends_as_denied_with_the_reason(api, fake_tab):
    """ACC-USB-49 a `request-result` that is not ok ends the request as denied with the browser's reason; a second answer changes nothing."""
    tab = await fake_tab()
    status, request = await api("POST", "requests",
                                body={"kind": "usb", "reason": "flash", "program": "pytest"})
    reason = {"name": "NotFoundError", "message": "No device selected."}

    await tab.send({"type": "request-result", "id": request["id"], "ok": False, "error": reason})
    await tab.send({"type": "request-result", "id": request["id"], "ok": True, "name": USB_NAME})
    await tab.send({"type": "request-result", "id": "unknown", "ok": True, "name": USB_NAME})

    status, answered = await api("GET", "requests", request["id"], wait=5)
    assert answered == {**request, "state": "denied", "error": reason}
    await tab.send({"type": "ping", "t": 0})
    await tab.until(lambda: tab.got("pong"))
    assert (await api("GET", "requests", request["id"]))[1]["state"] == "denied"


async def test_acc_usb_50_a_request_nobody_answers_stays_pending_then_expires(api, fake_tab, monkeypatch):
    """ACC-USB-50 a request with no answer is pending when the caller's wait ends, and expires after the server's limit."""
    monkeypatch.setattr(manager_module, "REQUEST_TTL_S", 1.5)
    tab = await fake_tab()
    status, request = await api("POST", "requests",
                                body={"kind": "usb", "reason": "flash", "program": "pytest"})

    started = time.monotonic()
    status, waiting = await api("GET", "requests", request["id"], wait=0.2)
    assert (status, waiting["state"]) == (200, "pending") and time.monotonic() - started > 0.15

    status, expired = await api("GET", "requests", request["id"], wait=10)
    assert expired["state"] == "expired" and 1.4 < time.monotonic() - started < 8
    await tab.until(lambda: tab.requests["pending"] == [])


@pytest.mark.parametrize("body, field", [
    ({"reason": "r", "program": "p"}, "kind"),
    ({"kind": "hid", "reason": "r", "program": "p"}, "kind"),
    ({"kind": "usb", "program": "p"}, "reason"),
    ({"kind": "usb", "reason": " ", "program": "p"}, "reason"),
    ({"kind": "usb", "reason": "r"}, "program"),
    ({"kind": "usb", "reason": "r", "program": "p", "vendorId": "0483"}, "vendorId"),
    ({"kind": "usb", "reason": "r", "program": "p", "productId": 0x10000}, "productId"),
])
async def test_acc_usb_47_a_malformed_request_is_400(body, field, api, fake_tab):
    """ACC-USB-47 a device request without a kind, a reason or a program, or with an id that is no 16-bit number, is refused with status 400."""
    tab = await fake_tab()

    status, document = await api("POST", "requests", body=body)

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith(f"{field}: ")
    assert (await api("GET", "requests"))[1] == {"requests": []} and tab.requests["pending"] == []


async def test_acc_usb_50_an_unknown_request_is_404(api):
    """ACC-USB-50 a request id that the server does not know is answered 404 with the code unknown-request."""
    status, document = await api("GET", "requests", "abcd1234", wait=5)

    assert (status, document["error"]["code"]) == (404, "unknown-request")
