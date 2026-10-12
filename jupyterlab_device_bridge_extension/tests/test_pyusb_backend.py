"""Tests of the pyusb backend: pyusb programs against the USB device of the browser tab double.

pyusb blocks. The test server and the tab double run on the event loop of the test,
so every pyusb call runs in a thread.

The tab double does not refuse a transfer on a closed device or on an interface that
is not claimed, as Chrome does. These tests read the order of the operations it got.
"""

import asyncio
import errno
import sys
import time
import types

import pytest
import usb.backend.libusb1
import usb.core
import usb.util

from jupyterlab_device_bridge_extension import pyusb_backend
from jupyterlab_device_bridge_extension.client import DeviceBridgeClient
from jupyterlab_device_bridge_extension.tests.fake_tab import (
    DEVICE_DESCRIPTOR,
    USB_MANUFACTURER,
    USB_NAME,
    USB_PRODUCT,
    USB_PRODUCT_NAME,
    USB_SERIAL,
    USB_VENDOR,
)

from .test_client import attach_usb, lab  # noqa: F401 - `lab` is a fixture

IDS = {"idVendor": USB_VENDOR, "idProduct": USB_PRODUCT}

# The two functions of the package `libusb_package` that pyOCD calls, written from
# knowledge of that package. It is not installed here.
LIBUSB_PACKAGE = """
import usb.backend.libusb1
import usb.core

def find_library(candidate):
    return None

def get_libusb1_backend():
    return usb.backend.libusb1.get_backend(find_library=find_library)

def find(*args, **kwargs):
    return usb.core.find(*args, backend=get_libusb1_backend(), **kwargs)
"""


def operations(tab):
    """The name of every USB operation a tab got, in order."""
    return [op for op, _ in tab.usb_calls]


def program(backend):
    """A pyusb program: find the device, run a control transfer in and out, write, read, read the strings, let go."""
    device = usb.core.find(backend=backend, **IDS)
    device.set_configuration()
    descriptor = device.ctrl_transfer(0x80, 6, 0x0100, 0, 18)
    sent = device.ctrl_transfer(0x40, 9, 2, 3, b"\x01\x02")
    written = device.write(0x01, b"\x10\x20\x30")
    read = device.read(0x81, 64)
    strings = (device.manufacturer, device.product, device.serial_number)
    device.set_interface_altsetting(interface=0, alternate_setting=0)
    device.clear_halt(0x81)
    driver = device.is_kernel_driver_active(0)
    device.reset()
    usb.util.dispose_resources(device)
    return device, bytes(descriptor), sent, written, bytes(read), strings, driver


def configured_device(backend):
    """The device of the tab double, found and with its configuration set."""
    device = usb.core.find(backend=backend, **IDS)
    device.set_configuration()
    return device


async def let_go(device):
    """Release and close a device that a test left open.

    pyusb closes an open device when the object is collected. That happens on the
    thread of the event loop, where the call would wait for a server that cannot answer.
    """
    await asyncio.to_thread(usb.util.dispose_resources, device)


@pytest.fixture
def default_backend(monkeypatch):
    """Put pyusb's own default backend function back after a test that called `install`."""
    monkeypatch.setattr(usb.backend.libusb1, "get_backend", usb.backend.libusb1.get_backend)


async def test_acc_usb_59_a_pyusb_program_finds_the_device_and_transfers(fake_tab, bridge_address):
    """ACC-USB-59 a pyusb program finds a bridged device through the backend and runs a control transfer, a write and a read."""
    tab = await attach_usb(fake_tab)
    backend = pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address))

    device, descriptor, sent, written, read, strings, driver = await asyncio.to_thread(program, backend)

    assert (device.idVendor, device.idProduct, device.bNumConfigurations) == (USB_VENDOR, USB_PRODUCT, 1)
    (interface,) = device[0].interfaces()
    assert interface.bInterfaceClass == 0xFF
    assert [endpoint.bEndpointAddress for endpoint in interface.endpoints()] == [0x01, 0x81]
    assert descriptor == DEVICE_DESCRIPTOR
    assert (sent, written, read) == (2, 3, b"\x10\x20\x30")
    assert strings == (USB_MANUFACTURER, USB_PRODUCT_NAME, USB_SERIAL)
    done = operations(tab)
    # The search reads the descriptors of a closed device: it opens it and closes it again.
    assert done[:5] == ["open", "control-in", "control-in", "control-in", "close"]
    assert done[5:7] == ["open", "select-configuration"]
    assert done.index("claim-interface") < done.index("transfer-out") < done.index("transfer-in")
    calls = dict(tab.usb_calls)
    assert calls["select-configuration"] == {"configurationValue": 1}
    assert calls["claim-interface"] == {"interfaceNumber": 0}
    assert calls["control-out"] == {"requestType": "vendor", "recipient": "device", "request": 9, "value": 2,
                                    "index": 3, "data": "AQI="}
    assert calls["transfer-out"] == {"endpointNumber": 1, "data": "ECAw"}
    assert calls["transfer-in"] == {"endpointNumber": 1, "length": 64, "timeout": 1000}
    assert calls["select-alternate"] == {"interfaceNumber": 0, "alternateSetting": 0}
    assert calls["clear-halt"] == {"direction": "in", "endpointNumber": 1}
    # pyusb's reset releases the interface, resets the device and closes it.
    assert done[-5:] == ["select-alternate", "clear-halt", "release-interface", "reset", "close"]
    assert tab.usb_opened is False and driver is False


async def test_acc_usb_59_a_search_finds_the_attached_devices_only(fake_tab, bridge_address):
    """ACC-USB-59 a search for other ids finds nothing, a search for all devices finds the attached device, and a detached device is not found."""
    tab = await attach_usb(fake_tab)
    backend = pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address))

    other = await asyncio.to_thread(lambda: usb.core.find(backend=backend, idVendor=0x1234))
    every = await asyncio.to_thread(lambda: list(usb.core.find(backend=backend, find_all=True)))
    await tab.release(USB_NAME)
    await tab.until(lambda: tab.devices["usb"][0]["state"] == "detached")
    detached = await asyncio.to_thread(lambda: usb.core.find(backend=backend, **IDS))

    assert other is None and detached is None
    assert [(device.idVendor, device.idProduct) for device in every] == [(USB_VENDOR, USB_PRODUCT)]


def test_acc_usb_59_a_configuration_descriptor_is_parsed_as_pyusb_wants_it():
    """ACC-USB-59 a raw configuration descriptor gives pyusb each interface with its alternate settings, their endpoints, and the descriptors of other types."""
    raw = bytes([
        9, 2, 59, 0, 2, 1, 0, 0x80, 50,       # configuration 1, two interfaces
        9, 4, 0, 0, 1, 0xFF, 0, 0, 4,         # interface 0, alternate 0, one endpoint
        7, 5, 0x81, 3, 8, 0, 10,              # interrupt IN 1
        9, 4, 0, 1, 2, 0xFF, 0, 0, 0,         # interface 0, alternate 1, two endpoints
        7, 5, 0x02, 2, 64, 0, 0,              # bulk OUT 2
        7, 5, 0x82, 2, 0, 2, 0,               # bulk IN 2, 512 bytes
        9, 4, 1, 0, 0, 0xFE, 1, 1, 0,         # interface 1: DFU, no endpoint
        9, 0x21, 0x0B, 0xFF, 0, 0, 4, 0x1A, 1,  # its DFU functional descriptor
    ])

    configuration = pyusb_backend._parse_configuration(raw)

    assert (configuration.bConfigurationValue, configuration.wTotalLength, configuration.bNumInterfaces) == (1, 59, 2)
    (first, second), (dfu,) = configuration.interfaces
    assert (first.bAlternateSetting, second.bAlternateSetting, first.iInterface) == (0, 1, 4)
    assert [endpoint.bEndpointAddress for endpoint in first.endpoints] == [0x81]
    assert [(endpoint.bEndpointAddress, endpoint.wMaxPacketSize) for endpoint in second.endpoints] == [
        (0x02, 64), (0x82, 512)]
    assert (dfu.bInterfaceClass, dfu.endpoints) == (0xFE, [])
    assert bytes(dfu.extra_descriptors) == bytes([9, 0x21, 0x0B, 0xFF, 0, 0, 4, 0x1A, 1])
    assert first.extra_descriptors == [] and configuration.extra_descriptors == []


async def test_acc_usb_59_install_makes_the_bridge_the_default_backend(lab, fake_tab, default_backend):
    """ACC-USB-59 after `install()` a program that passes no backend to `usb.core.find` gets the bridged device."""
    await attach_usb(fake_tab)

    backend = await asyncio.to_thread(pyusb_backend.install)
    device = await asyncio.to_thread(lambda: usb.core.find(**IDS))

    assert device is not None and device.backend is backend
    assert await asyncio.to_thread(lambda: bytes(device.ctrl_transfer(0x80, 6, 0x0100, 0, 18))) == DEVICE_DESCRIPTOR
    await let_go(device)


async def test_acc_usb_59_install_reaches_a_program_that_uses_libusb_package(
        fake_tab, bridge_address, default_backend, monkeypatch):
    """ACC-USB-59 (stand-in for `libusb_package`, which is not installed) after `install()` its `find` returns the bridged device."""
    await attach_usb(fake_tab)
    stand_in = types.ModuleType("libusb_package")
    exec(LIBUSB_PACKAGE, stand_in.__dict__)
    monkeypatch.setitem(sys.modules, "libusb_package", stand_in)

    backend = pyusb_backend.install(DeviceBridgeClient(*bridge_address))
    device = await asyncio.to_thread(lambda: stand_in.find(**IDS))

    assert stand_in.get_libusb1_backend() is backend
    assert device is not None and device.backend is backend


async def test_acc_usb_61_a_stall_is_a_pipe_error(fake_tab, bridge_address):
    """ACC-USB-61 a transfer the device ends with stall reaches a pyusb program as USBError with errno EPIPE."""
    tab = await attach_usb(fake_tab)
    device = await asyncio.to_thread(
        configured_device, pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address)))
    tab.stall = True

    for transfer in ((device.read, 0x81, 64), (device.write, 0x01, b"\x01"),
                     (device.ctrl_transfer, 0xC0, 7, 0, 0, 4)):
        with pytest.raises(usb.core.USBError) as stalled:
            await asyncio.to_thread(*transfer)
        assert stalled.value.errno == errno.EPIPE
        assert "stall" in str(stalled.value)
    await let_go(device)


async def test_acc_usb_59_a_read_without_data_is_the_pyusb_timeout_error(fake_tab, bridge_address):
    """ACC-USB-59 a read that gets no bytes within its timeout raises USBTimeoutError, and the next read returns the bytes written since."""
    tab = await attach_usb(fake_tab)
    backend = pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address))
    # This program sets no configuration: pyusb asks the device which one is active.
    device = await asyncio.to_thread(lambda: usb.core.find(backend=backend, **IDS))

    with pytest.raises(usb.core.USBTimeoutError) as timed_out:
        await asyncio.to_thread(device.read, 0x81, 64, 200)
    assert timed_out.value.errno == errno.ETIMEDOUT
    assert ("control-in", {"requestType": "standard", "recipient": "device", "request": 8, "value": 0,
                           "index": 0, "length": 1}) in tab.usb_calls
    assert "select-configuration" not in operations(tab)

    await asyncio.to_thread(device.write, 0x01, b"late")
    assert bytes(await asyncio.to_thread(device.read, 0x81, 64, 200)) == b"late"
    await let_go(device)


async def test_acc_usb_59_the_timeout_of_a_write_and_of_a_control_transfer_ends_the_wait(fake_tab, bridge_address):
    """ACC-USB-59 a write and a control transfer that the browser does not answer raise USBTimeoutError after their own timeout, not after the bridge's 5 s."""
    tab = await attach_usb(fake_tab)
    device = await asyncio.to_thread(
        configured_device, pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address)))
    await asyncio.to_thread(device.write, 0x01, b"claims the interface")
    tab.answers = False
    started = time.monotonic()

    for transfer in ((device.write, 0x01, b"\x01", 300), (device.ctrl_transfer, 0x80, 6, 0x0100, 0, 18, 300),
                     (device.ctrl_transfer, 0x40, 9, 0, 0, b"\x01", 300)):
        with pytest.raises(usb.core.USBTimeoutError):
            await asyncio.to_thread(*transfer)

    assert 0.9 <= time.monotonic() - started < 4
    tab.answers = True
    await let_go(device)


async def test_acc_usb_60_a_refusal_of_the_browser_is_a_usb_error_with_chromes_text(fake_tab, bridge_address):
    """ACC-USB-60 a refusal of the browser reaches a pyusb program as USBError with Chrome's error name and message."""
    tab = await attach_usb(fake_tab)
    device = await asyncio.to_thread(
        configured_device, pyusb_backend.get_backend(DeviceBridgeClient(*bridge_address)))
    tab.error = ("NetworkError", "Unable to claim interface.")

    with pytest.raises(usb.core.USBError) as refused:
        await asyncio.to_thread(device.write, 0x01, b"\x01")

    assert refused.value.errno == errno.EIO
    assert "NetworkError: Unable to claim interface." in str(refused.value)
    assert not isinstance(refused.value, usb.core.USBTimeoutError)
    tab.error = None
    await let_go(device)
