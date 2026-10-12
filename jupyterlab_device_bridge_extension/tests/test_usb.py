"""Tests of the USB relay through the real server, against the USB device of the fake tab."""

import asyncio
import base64
import time

import pytest

from jupyterlab_device_bridge_extension.tests.fake_tab import (
    CONFIGURATION_DESCRIPTOR,
    DEVICE_DESCRIPTOR,
    USB_ENDPOINT,
    USB_MANUFACTURER,
    USB_NAME,
    USB_PRODUCT,
    USB_PRODUCT_NAME,
    USB_SERIAL,
    USB_VENDOR,
    VENDOR_ANSWER,
)
from jupyterlab_device_bridge_extension.usb import ACK_GRACE_S, OPS, UsbDevice, plan

GET_DESCRIPTOR = {"requestType": "standard", "recipient": "device", "request": 6, "index": 0}


def b64(data):
    return base64.b64encode(data).decode()


def record(tab):
    return next(device for device in tab.devices["usb"] if device["name"] == USB_NAME)


async def attach(fake_tab):
    """A connected tab that holds the USB device and has sent its descriptors."""
    tab = await fake_tab()
    assert await tab.claim_usb() == {"type": "claimed", "key": tab.got("claimed")[0]["key"], "ok": True,
                                     "name": USB_NAME}
    await tab.until(lambda: tab.devices["usb"])
    return tab


async def test_acc_usb_51_descriptors_list_configurations_interfaces_endpoints_and_strings(api, fake_tab):
    """ACC-USB-51 `GET usb/<name>` lists the device's configurations, interfaces, endpoints and strings."""
    tab = await attach(fake_tab)
    for _ in range(200):
        status, descriptors = await api("GET", "usb", USB_NAME)
        if descriptors["configurations"]:
            break
        await asyncio.sleep(0.01)

    assert status == 200
    (configuration,) = descriptors["configurations"]
    assert configuration["configurationValue"] == 1
    (interface,) = configuration["interfaces"]
    assert (interface["interfaceNumber"], interface["alternates"][0]["interfaceClass"]) == (0, 0xFF)
    assert interface["alternates"][0]["endpoints"] == [
        {"endpointNumber": USB_ENDPOINT, "direction": "out", "type": "bulk", "packetSize": 64},
        {"endpointNumber": USB_ENDPOINT, "direction": "in", "type": "bulk", "packetSize": 64}]
    assert (descriptors["manufacturerName"], descriptors["productName"], descriptors["serialNumber"]) == (
        USB_MANUFACTURER, USB_PRODUCT_NAME, USB_SERIAL)
    assert (descriptors["vendorId"], descriptors["productId"]) == (USB_VENDOR, USB_PRODUCT)
    assert descriptors["opened"] is False and "raw" not in descriptors
    assert (record(tab)["productName"], record(tab)["opened"]) == (USB_PRODUCT_NAME, False)


def test_acc_usb_51_the_claim_alone_already_names_the_device():
    """ACC-USB-51 until the tab sends descriptors a device answers the ids and strings of its claim."""
    device = UsbDevice("usb-1209-0001", 0x1209, 0x0001, product_name="Bare")

    assert device.descriptors == {
        "vendorId": 0x1209, "productId": 0x0001, "manufacturerName": None, "productName": "Bare",
        "serialNumber": None, "configurations": [], "opened": False}
    assert device.record() == {
        "name": "usb-1209-0001", "state": "detached", "tab": None, "vendorId": 0x1209,
        "productId": 0x0001, "productName": "Bare", "manufacturerName": None, "serialNumber": None,
        "opened": False, "holder": None, "rx": 0, "tx": 0, "error": None}


def test_acc_usb_62_only_a_transfer_in_carries_a_timeout_to_the_tab():
    """ACC-USB-62 a transfer in tells the tab the caller's time and the server waits longer than that; every other operation waits the caller's time."""
    assert plan("transfer-in", {"endpointNumber": 1, "length": 8, "timeout": 300}, 5.0) == (
        {"endpointNumber": 1, "length": 8, "timeout": 300}, 0.3 + ACK_GRACE_S)
    assert plan("transfer-in", {"endpointNumber": 1, "length": 8}, 5.0) == (
        {"endpointNumber": 1, "length": 8, "timeout": 5000}, 5.0 + ACK_GRACE_S)
    assert plan("transfer-out", {"endpointNumber": 1, "data": "AA==", "timeout": 300}, 5.0) == (
        {"endpointNumber": 1, "data": "AA=="}, 0.3)
    assert plan("open", {}, 5.0) == ({}, 5.0)
    assert plan("open", {"timeout": 0}, 5.0) == ({}, 5.0), "a timeout of 0 is the default wait"
    assert len(OPS) == 12


async def test_acc_usb_52_open_and_close_reach_the_browser_device(api, fake_tab):
    """ACC-USB-52 open and close reach the tab's device, and the record and the descriptors follow."""
    tab = await attach(fake_tab)

    assert await api("POST", "usb", USB_NAME, "open") == (200, {})
    assert tab.usb_calls == [("open", {})] and tab.usb_opened
    await tab.until(lambda: record(tab)["opened"])
    status, descriptors = await api("GET", "usb", USB_NAME)
    assert descriptors["opened"] is True
    assert descriptors["raw"] == {"device": b64(DEVICE_DESCRIPTOR),
                                  "configurations": [b64(CONFIGURATION_DESCRIPTOR)]}

    assert await api("POST", "usb", USB_NAME, "close") == (200, {})
    assert tab.usb_calls == [("open", {}), ("close", {})] and not tab.usb_opened
    await tab.until(lambda: not record(tab)["opened"])
    assert (await api("GET", "usb", USB_NAME))[1]["opened"] is False
    assert [event["op"] for event in tab.got("usb")] == ["open", "close"]
    assert all(event["name"] == USB_NAME and isinstance(event["seq"], int) for event in tab.got("usb"))


async def test_acc_panel_112_the_record_names_the_program_that_has_the_device_open(api, fake_tab):
    """ACC-PANEL-112 an open with a program name puts `holder` with that name into the USB record, the name does not reach the tab, and after close the record has no holder."""
    tab = await attach(fake_tab)
    assert record(tab)["holder"] is None

    assert await api("POST", "usb", USB_NAME, "open", body={"program": "pyocd"}) == (200, {})

    assert tab.usb_calls == [("open", {})], "the program name is no argument of the WebUSB call"
    await tab.until(lambda: record(tab)["holder"])
    assert (record(tab)["opened"], record(tab)["holder"]) == (True, {"name": "pyocd"})
    assert (await api("GET", "devices"))[1]["usb"] == [record(tab)]

    assert await api("POST", "usb", USB_NAME, "close") == (200, {})

    await tab.until(lambda: not record(tab)["opened"])
    assert record(tab)["holder"] is None
    assert (await api("GET", "devices"))[1]["usb"][0]["holder"] is None


def test_acc_panel_112_descriptors_keep_the_holder_while_they_say_open():
    """ACC-PANEL-112 the descriptors the tab sends after an open keep the holder, and descriptors of a closed device end it."""
    device = UsbDevice("usb-1209-0001", 0x1209, 0x0001)
    device.set_opened(True, "pyocd")

    device.set_descriptors({**device.descriptors, "opened": True})
    assert (device.record()["opened"], device.record()["holder"]) == (True, {"name": "pyocd"})

    device.set_descriptors({**device.descriptors, "opened": False})
    assert (device.record()["opened"], device.record()["holder"]) == (False, None)


async def test_acc_panel_112_an_open_without_a_program_name_has_no_holder(api, fake_tab):
    """ACC-PANEL-112 a device that a caller opened without a program name is open and has no holder."""
    tab = await attach(fake_tab)

    assert await api("POST", "usb", USB_NAME, "open") == (200, {})

    await tab.until(lambda: record(tab)["opened"])
    assert record(tab)["holder"] is None


async def test_acc_panel_112_the_holder_ends_when_the_device_is_removed(api, fake_tab):
    """ACC-PANEL-112 after the tab reports the device removed the record has no holder."""
    tab = await attach(fake_tab)
    await api("POST", "usb", USB_NAME, "open", body={"program": "dfu-util"})
    await tab.until(lambda: record(tab)["holder"] == {"name": "dfu-util"})

    await tab.release(USB_NAME, "removed")

    await tab.until(lambda: record(tab)["state"] == "detached")
    assert (record(tab)["opened"], record(tab)["holder"]) == (False, None)


async def test_acc_panel_112_the_holder_ends_when_the_tab_is_lost(api, fake_tab):
    """ACC-PANEL-112 after the WebSocket of the tab that holds the device closed the record has no holder."""
    tab = await attach(fake_tab)
    await api("POST", "usb", USB_NAME, "open", body={"program": "dfu-util"})
    await tab.until(lambda: record(tab)["holder"] == {"name": "dfu-util"})

    await tab.close()

    for _ in range(200):
        status, table = await api("GET", "devices")
        if table["usb"][0]["state"] == "detached":
            break
        await asyncio.sleep(0.01)
    assert (table["usb"][0]["state"], table["usb"][0]["opened"], table["usb"][0]["holder"]) == (
        "detached", False, None)


@pytest.mark.parametrize("program", ["", "   ", 7, ["pyocd"], {"name": "pyocd"}, True])
async def test_acc_panel_112_a_program_name_that_is_no_text_is_400(program, api, fake_tab):
    """ACC-PANEL-112 an open whose program name is empty or no text is refused with status 400 and does not reach the tab."""
    tab = await attach(fake_tab)

    status, document = await api("POST", "usb", USB_NAME, "open", body={"program": program})

    assert (status, document) == (400, {"error": {
        "code": "bad-request", "message": "program: a text that is not empty"}})
    assert tab.usb_calls == []
    assert (record(tab)["opened"], record(tab)["holder"]) == (False, None)


async def test_acc_usb_53_operations_reach_the_browser_device_with_their_numbers(api, fake_tab):
    """ACC-USB-53 (relay half) configuration, interface, alternate setting, clear halt and reset reach the tab with their arguments."""
    tab = await attach(fake_tab)
    calls = [("select-configuration", {"configurationValue": 1}),
             ("claim-interface", {"interfaceNumber": 0}),
             ("select-alternate", {"interfaceNumber": 0, "alternateSetting": 1}),
             ("clear-halt", {"direction": "in", "endpointNumber": 1}),
             ("release-interface", {"interfaceNumber": 0}),
             ("reset", {})]

    for op, args in calls:
        assert await api("POST", "usb", USB_NAME, op, body={**args, "timeout": 2000}) == (200, {})

    assert tab.usb_calls == calls, "the timeout of the caller is not an argument of these operations"


async def test_acc_usb_54_control_transfers_carry_the_bytes_both_ways(api, fake_tab):
    """ACC-USB-54 a control transfer in returns the device's bytes and a control transfer out delivers the caller's bytes."""
    tab = await attach(fake_tab)
    await api("POST", "usb", USB_NAME, "open")

    status, result = await api("POST", "usb", USB_NAME, "control-in",
                               body={**GET_DESCRIPTOR, "value": 0x0100, "length": 18})
    assert (status, result) == (200, {"status": "ok", "data": b64(DEVICE_DESCRIPTOR)})
    status, result = await api("POST", "usb", USB_NAME, "control-in",
                               body={**GET_DESCRIPTOR, "value": 0x0200, "length": 9})
    assert base64.b64decode(result["data"]) == CONFIGURATION_DESCRIPTOR[:9]
    status, result = await api("POST", "usb", USB_NAME, "control-in",
                               body={**GET_DESCRIPTOR, "value": 0x0302, "index": 0x0409, "length": 255})
    assert base64.b64decode(result["data"])[2:].decode("utf-16-le") == USB_PRODUCT_NAME
    status, result = await api("POST", "usb", USB_NAME, "control-in", body={
        "requestType": "vendor", "recipient": "interface", "request": 7, "value": 1, "index": 2, "length": 4})
    assert base64.b64decode(result["data"]) == VENDOR_ANSWER

    payload = bytes(range(256))
    setup = {"requestType": "vendor", "recipient": "device", "request": 9, "value": 2, "index": 3}
    status, result = await api("POST", "usb", USB_NAME, "control-out", body={**setup, "data": b64(payload)})

    assert (status, result) == (200, {"status": "ok", "bytesWritten": 256})
    assert tab.usb_calls[-1] == ("control-out", {**setup, "data": b64(payload)})


async def test_acc_usb_55_bulk_transfers_carry_the_bytes_both_ways(api, fake_tab):
    """ACC-USB-55 a bulk transfer out delivers the caller's bytes and a bulk transfer in returns the device's bytes."""
    tab = await attach(fake_tab)
    payload = bytes(range(256)) * 4

    status, result = await api("POST", "usb", USB_NAME, "transfer-out",
                               body={"endpointNumber": USB_ENDPOINT, "data": b64(payload)})
    assert (status, result) == (200, {"status": "ok", "bytesWritten": 1024})
    assert bytes(tab.loopback) == payload

    status, first = await api("POST", "usb", USB_NAME, "transfer-in",
                              body={"endpointNumber": USB_ENDPOINT, "length": 100, "timeout": 1000})
    status, rest = await api("POST", "usb", USB_NAME, "transfer-in",
                             body={"endpointNumber": USB_ENDPOINT, "length": 4096})
    assert (first["status"], rest["status"]) == ("ok", "ok")
    assert base64.b64decode(first["data"]) + base64.b64decode(rest["data"]) == payload
    assert len(base64.b64decode(first["data"])) == 100
    assert [args.get("timeout") for op, args in tab.usb_calls] == [None, 1000, 5000], (
        "a transfer in tells the tab how long to wait: the caller's time, or the default")


async def test_acc_usb_62_a_timed_out_transfer_in_is_504_and_loses_nothing(api, fake_tab):
    """ACC-USB-62 (relay half) a transfer in that gets no data in the caller's time is answered 504, and the next one returns the bytes that arrived meanwhile."""
    await attach(fake_tab)

    started = time.monotonic()
    status, document = await api("POST", "usb", USB_NAME, "transfer-in",
                                 body={"endpointNumber": USB_ENDPOINT, "length": 64, "timeout": 300})
    took = time.monotonic() - started

    assert (status, document["error"]["code"]) == (504, "timeout")
    assert document["error"]["message"] == "No data on endpoint 1 within 300 ms", (
        "the tab's own answer ends the wait, not the server's later limit")
    assert 0.25 < took < 3

    await api("POST", "usb", USB_NAME, "transfer-out", body={"endpointNumber": USB_ENDPOINT, "data": b64(b"late")})
    status, result = await api("POST", "usb", USB_NAME, "transfer-in",
                               body={"endpointNumber": USB_ENDPOINT, "length": 64, "timeout": 300})
    assert (status, base64.b64decode(result["data"])) == (200, b"late")


async def test_acc_usb_55_a_waiting_transfer_in_gets_data_that_arrives_and_blocks_no_other_call(api, fake_tab):
    """ACC-USB-55 a transfer in that waits returns the bytes a transfer out delivers meanwhile."""
    tab = await attach(fake_tab)
    reading = asyncio.ensure_future(api("POST", "usb", USB_NAME, "transfer-in",
                                        body={"endpointNumber": USB_ENDPOINT, "length": 64, "timeout": 5000}))
    await tab.until(lambda: tab.usb_calls)

    started = time.monotonic()
    status, written = await api("POST", "usb", USB_NAME, "transfer-out",
                                body={"endpointNumber": USB_ENDPOINT, "data": b64(b"answer")})
    status, read = await reading

    assert written["bytesWritten"] == 6 and time.monotonic() - started < 2
    assert (status, base64.b64decode(read["data"])) == (200, b"answer")


async def test_acc_usb_60_a_refusal_of_the_browser_is_502_with_its_name_and_message(api, fake_tab):
    """ACC-USB-60 (relay half) an operation the browser refuses is answered 502 with the browser's error name and message unchanged."""
    tab = await attach(fake_tab)
    tab.error = ("NetworkError", "Unable to claim interface.")

    status, document = await api("POST", "usb", USB_NAME, "claim-interface", body={"interfaceNumber": 0})

    assert status == 502
    assert document == {"error": {"code": "browser", "name": "NetworkError",
                                  "message": "Unable to claim interface."}}
    assert tab.got("usb")[-1]["args"] == {"interfaceNumber": 0}


async def test_acc_usb_61_a_stall_is_a_result_with_that_status(api, fake_tab):
    """ACC-USB-61 (relay half) a stalled transfer is answered 200 with the status stall."""
    tab = await attach(fake_tab)
    tab.stall = True

    for op, body in (("control-in", {**GET_DESCRIPTOR, "value": 0x0100, "length": 18}),
                     ("transfer-out", {"endpointNumber": USB_ENDPOINT, "data": "AA=="}),
                     ("transfer-in", {"endpointNumber": USB_ENDPOINT, "length": 8})):
        assert await api("POST", "usb", USB_NAME, op, body=body) == (200, {"status": "stall"})


async def test_acc_usb_63_an_operation_on_a_removed_device_is_409(api, fake_tab):
    """ACC-USB-63 after the tab reports the device removed an operation is answered 409 with a message that says detached, and the list shows it detached."""
    tab = await attach(fake_tab)
    await api("POST", "usb", USB_NAME, "open")
    await tab.until(lambda: record(tab)["opened"])

    await tab.release(USB_NAME, "removed")
    await tab.until(lambda: record(tab)["state"] == "detached")

    status, document = await api("POST", "usb", USB_NAME, "transfer-in",
                                 body={"endpointNumber": USB_ENDPOINT, "length": 64})
    assert (status, document["error"]["code"]) == (409, "detached")
    assert document["error"]["message"] == f"{USB_NAME} is detached: no lab tab holds it"
    status, table = await api("GET", "devices")
    assert table["usb"] == [{**record(tab), "state": "detached", "tab": None, "opened": False,
                             "error": "removed"}]
    assert tab.usb_calls == [("open", {})]
    status, descriptors = await api("GET", "usb", USB_NAME)
    assert (status, descriptors["opened"], descriptors["productName"]) == (200, False, USB_PRODUCT_NAME), (
        "the descriptors of a detached device stay readable")


async def test_acc_usb_63_forget_removes_the_device(api, fake_tab):
    """ACC-USB-63 a release with reason forget removes the device from the list."""
    tab = await attach(fake_tab)

    await tab.release(USB_NAME, "forget")

    await tab.until(lambda: tab.devices["usb"] == [])
    assert (await api("POST", "usb", USB_NAME, "open"))[0] == 404


async def test_acc_usb_60_a_tab_that_does_not_answer_is_504_at_the_callers_timeout(api, fake_tab):
    """ACC-USB-60 (relay half) an operation the tab does not ack is answered 504 when the caller's timeout ends."""
    tab = await attach(fake_tab)
    tab.answers = False

    started = time.monotonic()
    status, document = await api("POST", "usb", USB_NAME, "control-in",
                                 body={**GET_DESCRIPTOR, "value": 0x0100, "length": 18, "timeout": 300})

    assert (status, document) == (504, {"error": {"code": "timeout",
                                                  "message": "the tab did not answer in time"}})
    assert 0.25 < time.monotonic() - started < 2
    assert tab.got("usb")[-1]["args"] == {**GET_DESCRIPTOR, "value": 0x0100, "length": 18}


@pytest.mark.parametrize("op, body, message", [
    ("explode", {}, "unknown USB operation explode"),
    ("transfer", {}, "unknown USB operation transfer"),
    ("open", {"timeout": "soon"}, "timeout: 'soon' is not a number of milliseconds"),
    ("open", {"timeout": -5}, "timeout: -5 is not a number of milliseconds"),
    ("open", {"timeout": True}, "timeout: True is not a number of milliseconds"),
])
async def test_acc_usb_52_an_unknown_operation_or_a_malformed_timeout_is_400(op, body, message, api, fake_tab):
    """ACC-USB-52 an operation outside the twelve of the design, or a timeout that is no number of ms, is refused with status 400."""
    tab = await attach(fake_tab)

    status, document = await api("POST", "usb", USB_NAME, op, body=body)

    assert (status, document["error"]["code"]) == (400, "bad-request")
    assert document["error"]["message"].startswith(message)
    assert tab.usb_calls == []
