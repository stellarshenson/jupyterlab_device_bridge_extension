"""Tests of the Python client against the test server and the browser tab double.

The client blocks. The test server and the tab double run on the event loop of the
test, so every client call runs in a thread. The `lab` fixture of this module is
shared with the tests of the CLI and of the shim.
"""

import asyncio
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

import pytest

from jupyterlab_device_bridge_extension.client import NAMESPACE, DeviceBridgeClient, DeviceBridgeError
from jupyterlab_device_bridge_extension.tests.fake_tab import (
    DEVICE_DESCRIPTOR,
    SERIAL_NAME,
    USB_ENDPOINT,
    USB_NAME,
    VENDOR_ANSWER,
)
from jupyterlab_device_bridge_extension.usb import OPS

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
# What discovery reads besides the server list. This workstation's own lab sets the
# hub tokens; a test starts without any of them.
DISCOVERY_VARIABLES = ("JUPYTERHUB_API_TOKEN", "JPY_API_TOKEN", "JUPYTER_TOKEN", "JUPYTER_PORT",
                       "JUPYTERHUB_SERVICE_PREFIX")
NO_DEVICES = {"serial": [], "usb": []}
# A program that finds the server and prints its device table.
PRINT_DEVICES = ("from jupyterlab_device_bridge_extension.client import DeviceBridgeClient; "
                 "print(DeviceBridgeClient().devices())")


def list_server(directory, record):
    """Put a `jupyter` in `directory` whose `server list --json` prints this record, or nothing for None."""
    script = directory / "jupyter"
    script.write_text(f"#!/bin/sh\necho '{json.dumps(record) if record else ''}'\n")
    script.chmod(0o755)


@pytest.fixture
def lab(bridge_address, jp_http_port, jp_base_url, tmp_path, monkeypatch):
    """The environment of a lab terminal whose only Jupyter server is the test server.

    Discovery runs for real: the first `jupyter` on PATH lists the test server and
    nothing else, and the environment holds no token and no port of another server.
    So neither this process nor a child process reaches the workstation's own lab.
    HOME is an empty directory, where the shim is built for this test alone.

    Returns:
        The directory of that `jupyter`; `list_server` replaces what it lists.
    """
    binaries = tmp_path / "bin"
    binaries.mkdir()
    list_server(binaries, {"port": jp_http_port, "base_url": jp_base_url, "token": bridge_address[1]})
    monkeypatch.setenv("PATH", f"{binaries}{os.pathsep}{os.environ['PATH']}")
    for name in DISCOVERY_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PYTHONPATH", str(REPOSITORY))
    return binaries


def discover():
    """Find the server as a program does and ask it for the device table.

    Returns:
        `(client, table)`, or `(client, error)` when the server refused.
    """
    client = DeviceBridgeClient()
    try:
        return client, client.devices()
    except DeviceBridgeError as error:
        return client, error


async def attach_serial(fake_tab):
    """A connected tab that holds the serial port, and the path of the virtual device.

    The device table that shows the port open arrives after the answer to the claim,
    so this waits for the table and does not read it at once.
    """
    tab = await fake_tab()
    assert (await tab.claim_serial())["ok"]
    (record,) = await tab.until(
        lambda: [device for device in tab.devices["serial"] if device["portState"] == "open"])
    return tab, record["path"]


async def attach_usb(fake_tab):
    """A connected tab that holds the USB device."""
    tab = await fake_tab()
    assert (await tab.claim_usb())["ok"]
    await tab.until(lambda: tab.devices["usb"])
    return tab


async def test_acc_cli_83_token_order(lab, bridge_address, jp_http_port, jp_base_url, monkeypatch):
    """ACC-CLI-83 the hub token comes first, then the listed server's token, then JUPYTER_TOKEN."""
    url, token = bridge_address

    monkeypatch.setenv("JUPYTER_TOKEN", "stale-export")
    client, answer = await asyncio.to_thread(discover)
    assert (client.base_url, client.token) == (url, token)
    assert answer == NO_DEVICES, "the listed token outranks JUPYTER_TOKEN and the server accepts it"

    monkeypatch.setenv("JPY_API_TOKEN", "old-hub-token")
    client, answer = await asyncio.to_thread(discover)
    assert client.token == "old-hub-token"
    assert answer.status == 403, "the hub token was sent, not the listed one"

    monkeypatch.setenv("JUPYTERHUB_API_TOKEN", "hub-token")
    client, answer = await asyncio.to_thread(discover)
    assert client.token == "hub-token"
    assert answer.status == 403

    monkeypatch.delenv("JPY_API_TOKEN")
    monkeypatch.delenv("JUPYTERHUB_API_TOKEN")
    list_server(lab, None)
    monkeypatch.setenv("JUPYTER_PORT", str(jp_http_port))
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", jp_base_url)
    client, answer = await asyncio.to_thread(discover)
    assert (client.base_url, client.token) == (url, "stale-export")
    assert answer.status == 403, "with no listed server JUPYTER_TOKEN was sent"

    monkeypatch.setenv("JUPYTER_TOKEN", token)
    assert (await asyncio.to_thread(discover))[1] == NO_DEVICES


async def test_acc_cli_83_a_listed_empty_token_means_no_token(lab, jp_http_port, jp_base_url, monkeypatch):
    """ACC-CLI-83 a server listed with an empty token gets no token, also when JUPYTER_TOKEN is set."""
    list_server(lab, {"port": jp_http_port, "base_url": jp_base_url, "token": ""})
    monkeypatch.setenv("JUPYTER_TOKEN", "stale-export")

    client, answer = await asyncio.to_thread(discover)

    assert client.token is None
    assert answer.status == 403


async def test_acc_cli_83_loopback_without_a_proxy(lab, bridge_address, monkeypatch):
    """ACC-CLI-83 a request goes to loopback and ignores http_proxy."""
    for name in ("no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    # The proxy setting is live here: an opener that urllib builds now follows it, and
    # the dead proxy refuses the connection before any server could answer.
    with pytest.raises(urllib.error.URLError) as refused:
        await asyncio.to_thread(
            urllib.request.build_opener().open, f"{bridge_address[0]}/{NAMESPACE}/devices", None, 5)
    assert not isinstance(refused.value, urllib.error.HTTPError)

    # A program that starts with these settings; the client makes its opener at import.
    child = await asyncio.create_subprocess_exec(
        sys.executable, "-c", PRINT_DEVICES, stdout=asyncio.subprocess.PIPE)
    out, _ = await asyncio.wait_for(child.communicate(), 30)

    assert (child.returncode, out.decode().strip()) == (0, str(NO_DEVICES))


def every_operation(device):
    """Call each method of a `UsbDevice` once and return what the calls gave."""
    answers = {"describe": device.describe()}
    device.open()
    device.select_configuration(1)
    device.claim_interface(0)
    device.select_alternate(0, 0)
    answers["control_in"] = device.control_in("standard", "device", 6, 0x0100, 0, 18)
    answers["control_out"] = device.control_out("vendor", "interface", 9, 2, 3, b"\x01\x02\x03",
                                                timeout_ms=250)
    answers["control"] = device.control(0xC0, 7, 0, 0, 4)
    answers["transfer_out"] = device.transfer_out(USB_ENDPOINT, bytes(range(256)))
    answers["transfer_in"] = device.transfer_in(USB_ENDPOINT, 100, timeout_ms=500)
    answers["rest"] = device.transfer_in(USB_ENDPOINT, 512)
    device.clear_halt("in", USB_ENDPOINT)
    device.release_interface(0)
    device.reset()
    device.close()
    return answers


async def test_acc_usb_58_one_method_per_usb_operation(fake_tab, bridge_address):
    """ACC-USB-58 each USB operation has a client method that reaches the browser device; transfers return bytes."""
    tab = await attach_usb(fake_tab)

    answers = await asyncio.to_thread(every_operation, DeviceBridgeClient(*bridge_address).usb(USB_NAME))

    assert answers["describe"]["configurations"][0]["configurationValue"] == 1
    assert answers["control_in"] == DEVICE_DESCRIPTOR
    assert answers["control_out"] == 3
    assert answers["control"] == VENDOR_ANSWER
    assert answers["transfer_out"] == 256
    assert answers["transfer_in"] == bytes(range(100))
    assert answers["rest"] == bytes(range(100, 256))
    assert tab.usb_calls == [
        ("open", {}),
        ("select-configuration", {"configurationValue": 1}),
        ("claim-interface", {"interfaceNumber": 0}),
        ("select-alternate", {"interfaceNumber": 0, "alternateSetting": 0}),
        ("control-in", {"requestType": "standard", "recipient": "device", "request": 6,
                        "value": 0x0100, "index": 0, "length": 18}),
        ("control-out", {"requestType": "vendor", "recipient": "interface", "request": 9,
                         "value": 2, "index": 3, "data": "AQID"}),
        ("control-in", {"requestType": "vendor", "recipient": "device", "request": 7,
                        "value": 0, "index": 0, "length": 4}),
        ("transfer-out", {"endpointNumber": USB_ENDPOINT,
                          "data": base64.b64encode(bytes(range(256))).decode()}),
        ("transfer-in", {"endpointNumber": USB_ENDPOINT, "length": 100, "timeout": 500}),
        ("transfer-in", {"endpointNumber": USB_ENDPOINT, "length": 512, "timeout": 5000}),
        ("clear-halt", {"direction": "in", "endpointNumber": USB_ENDPOINT}),
        ("release-interface", {"interfaceNumber": 0}),
        ("reset", {}),
        ("close", {}),
    ]
    assert {op for op, _ in tab.usb_calls} == set(OPS), "every operation of the server has a method"
    assert tab.usb_opened is False


async def test_acc_panel_112_the_client_names_its_program_when_it_opens_a_usb_device(fake_tab, bridge_address):
    """ACC-PANEL-112 `open()` sends the program name of the client: the USB record carries it as holder until `close()`, and the browser device does not get it."""
    tab = await attach_usb(fake_tab)
    device = DeviceBridgeClient(*bridge_address, program="pyocd").usb(USB_NAME)

    await asyncio.to_thread(device.open)

    # The table with the holder follows the table that only says the device is open.
    await tab.until(lambda: tab.devices["usb"][0]["holder"])
    assert tab.devices["usb"][0]["holder"] == {"name": "pyocd"}
    assert tab.usb_calls == [("open", {})]

    await asyncio.to_thread(device.close)

    await tab.until(lambda: not tab.devices["usb"][0]["opened"])
    assert tab.devices["usb"][0]["holder"] is None


@pytest.mark.parametrize("argv, name", [
    (["/opt/tools/bin/dfu-flash", "--now"], "dfu-flash"),
    ([""], "python"),
])
def test_acc_panel_112_a_client_without_a_program_name_takes_the_running_program(argv, name, monkeypatch):
    """ACC-PANEL-112 a client that is given no program name names the running program, and `python` where that has no name."""
    monkeypatch.setattr(sys, "argv", argv)

    assert DeviceBridgeClient("http://127.0.0.1:1").program == name


async def test_acc_usb_58_a_read_with_no_data_raises_after_its_timeout(fake_tab, bridge_address):
    """ACC-USB-58 a transfer in that gets no bytes within its timeout raises with status 504."""
    await attach_usb(fake_tab)
    device = DeviceBridgeClient(*bridge_address).usb(USB_NAME)

    with pytest.raises(DeviceBridgeError) as timed_out:
        await asyncio.to_thread(device.transfer_in, USB_ENDPOINT, 64, 200)

    assert (timed_out.value.status, timed_out.value.code) == (504, "timeout")


async def test_acc_usb_58_a_timeout_of_0_is_the_timeout_of_the_bridge(fake_tab, bridge_address):
    """ACC-USB-58 a transfer in with timeout 0, which pyusb passes for "no timeout", waits the bridge's own 5 s and then raises with status 504."""
    await attach_usb(fake_tab)
    device = DeviceBridgeClient(*bridge_address).usb(USB_NAME)
    started = time.monotonic()

    with pytest.raises(DeviceBridgeError) as timed_out:
        await asyncio.to_thread(device.transfer_in, USB_ENDPOINT, 64, 0)

    assert (timed_out.value.status, timed_out.value.code) == (504, "timeout")
    assert time.monotonic() - started > 4.5


async def test_acc_usb_60_browser_error_reaches_the_caller(fake_tab, bridge_address):
    """ACC-USB-60 a refusal of the browser raises with Chrome's error name and message."""
    tab = await attach_usb(fake_tab)
    tab.error = ("NetworkError", "Unable to claim interface.")

    with pytest.raises(DeviceBridgeError) as refused:
        await asyncio.to_thread(DeviceBridgeClient(*bridge_address).usb(USB_NAME).claim_interface, 0)

    assert refused.value.status == 502
    assert refused.value.name == "NetworkError"
    assert refused.value.message == "Unable to claim interface."
    assert str(refused.value) == "NetworkError: Unable to claim interface."


async def test_acc_usb_61_a_stalled_transfer_raises_with_the_name_stall(fake_tab, bridge_address):
    """ACC-USB-61 a transfer the device ends with stall raises an error named `stall`."""
    tab = await attach_usb(fake_tab)
    tab.stall = True
    device = DeviceBridgeClient(*bridge_address).usb(USB_NAME)

    for transfer in ((device.transfer_in, USB_ENDPOINT, 64), (device.transfer_out, USB_ENDPOINT, b"\x01"),
                     (device.control, 0xC0, 7, 0, 0, 4), (device.control, 0x40, 7, 0, 0, b"\x01")):
        with pytest.raises(DeviceBridgeError) as stalled:
            await asyncio.to_thread(*transfer)
        assert stalled.value.name == "stall"


def every_serial_method(port):
    """Call each method of a `SerialDevice` once and return its record and the monitor's answer."""
    port.set_profile(profile="stm32-bootloader", baudRate=57600)
    port.write(bytes(range(256)))
    port.signals(dtr=False, rts=True)
    port.action("pulse-dtr")
    return port.record(), port.monitor()


async def test_acc_mon_43_the_serial_methods_of_the_client_reach_the_port(fake_tab, bridge_address):
    """ACC-MON-43 the client's write reaches the port, as do its profile, signals and action; monitor returns the port's bytes."""
    tab, _ = await attach_serial(fake_tab)
    bridge = DeviceBridgeClient(*bridge_address)

    record, chunk = await asyncio.to_thread(every_serial_method, bridge.serial(SERIAL_NAME))

    settings = {"baudRate": 57600, "dataBits": 8, "parity": "even", "stopBits": 1}
    assert tab.written(SERIAL_NAME) == bytes(range(256))
    assert tab.settings[SERIAL_NAME] == settings
    assert tab.signals[SERIAL_NAME] == {"dtr": False, "rts": True}
    assert [event["action"] for event in tab.got("serial-action")] == ["pulse-dtr"]
    assert (record["profile"], record["overrides"], record["settings"]) == (
        "stm32-bootloader", {"baudRate": 57600}, settings)
    assert record["path"].endswith(f"/{SERIAL_NAME}")
    # The port of the tab double echoes: the monitor holds what was written.
    assert chunk == {"data": bytes(range(256)), "start": 0, "next": 256, "dropped": False}
    with pytest.raises(DeviceBridgeError) as unknown:
        await asyncio.to_thread(bridge.serial("tty-none").record)
    assert (unknown.value.status, unknown.value.code) == (404, "unknown-device")


async def test_acc_sec_96_a_name_cannot_leave_its_route(fake_tab, bridge_address):
    """ACC-SEC-96 a device name with a slash is sent as one path segment, and the server refuses it."""
    await attach_usb(fake_tab)

    with pytest.raises(DeviceBridgeError) as refused:
        await asyncio.to_thread(DeviceBridgeClient(*bridge_address).usb("../devices").describe)

    assert (refused.value.status, refused.value.code) == (400, "invalid-name")
