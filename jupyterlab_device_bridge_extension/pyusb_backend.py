"""pyusb backend over the device bridge.

A pyusb program reaches a USB device that a lab tab holds:

    import usb.core
    from jupyterlab_device_bridge_extension import pyusb_backend

    probe = usb.core.find(idVendor=0x0D28, idProduct=0x0204,
                          backend=pyusb_backend.get_backend())

A program that passes no backend calls `install()` before its first
`usb.core.find` or `libusb_package.find`.

pyusb has no view of the browser's device list, so the backend reads the device
and configuration descriptors from each attached device with GET_DESCRIPTOR
control transfers. That needs the device open: a device the bridge reports as
closed is opened for the read and closed again.

Isochronous transfers are not offered. pyusb is imported only in this module.
"""

import array
import contextlib
import errno
import struct
from collections.abc import Iterator
from types import SimpleNamespace

import usb.backend
import usb.backend.libusb1
import usb.core

from .client import DeviceBridgeClient, DeviceBridgeError

_GET_CONFIGURATION = 8
_GET_DESCRIPTOR = 6
_DEVICE_IN = 0x80  # bmRequestType: device to host, standard, device
_DT_DEVICE, _DT_CONFIGURATION, _DT_INTERFACE, _DT_ENDPOINT = 1, 2, 4, 5
# Every bridged device reports this bus; its address is its number among them.
_BUS = 1

_DEVICE = struct.Struct("<BBHBBBBHHHBBBB")
_DEVICE_FIELDS = (
    "bLength", "bDescriptorType", "bcdUSB", "bDeviceClass", "bDeviceSubClass",
    "bDeviceProtocol", "bMaxPacketSize0", "idVendor", "idProduct", "bcdDevice",
    "iManufacturer", "iProduct", "iSerialNumber", "bNumConfigurations",
)
_CONFIGURATION = struct.Struct("<BBHBBBBB")
_CONFIGURATION_FIELDS = (
    "bLength", "bDescriptorType", "wTotalLength", "bNumInterfaces",
    "bConfigurationValue", "iConfiguration", "bmAttributes", "bMaxPower",
)
_INTERFACE = struct.Struct("<9B")
_INTERFACE_FIELDS = (
    "bLength", "bDescriptorType", "bInterfaceNumber", "bAlternateSetting", "bNumEndpoints",
    "bInterfaceClass", "bInterfaceSubClass", "bInterfaceProtocol", "iInterface",
)
_ENDPOINT = struct.Struct("<BBBBHB")
_ENDPOINT_FIELDS = (
    "bLength", "bDescriptorType", "bEndpointAddress", "bmAttributes", "wMaxPacketSize", "bInterval",
)


def _descriptor(layout: struct.Struct, fields: tuple[str, ...], raw: bytes,
                **more: object) -> SimpleNamespace:
    return SimpleNamespace(**dict(zip(fields, layout.unpack_from(raw))), **more)


def _parse_configuration(raw: bytes) -> SimpleNamespace:
    """A raw configuration descriptor as pyusb wants it.

    Returns:
        The configuration with `interfaces`: one list per interface number that
        holds its alternate settings in order, each with its `endpoints`. A
        descriptor of any other type goes to `extra_descriptors` of the
        descriptor it follows.
    """
    configuration = _descriptor(_CONFIGURATION, _CONFIGURATION_FIELDS, raw,
                                extra_descriptors=[], interfaces=[])
    interface = owner = configuration
    offset = configuration.bLength
    # A length below 2 is a malformed descriptor; stop instead of looping on it.
    while offset + 2 <= len(raw) and raw[offset] >= 2:
        part = raw[offset:offset + raw[offset]]
        if part[1] == _DT_INTERFACE:
            interface = owner = _descriptor(_INTERFACE, _INTERFACE_FIELDS, part,
                                            extra_descriptors=[], endpoints=[])
            alternates = configuration.interfaces
            if not alternates or alternates[-1][0].bInterfaceNumber != interface.bInterfaceNumber:
                alternates.append([])
            alternates[-1].append(interface)
        elif part[1] == _DT_ENDPOINT:
            owner = _descriptor(_ENDPOINT, _ENDPOINT_FIELDS, part,
                                bRefresh=0, bSynchAddress=0, extra_descriptors=[])
            interface.endpoints.append(owner)
        else:
            owner.extra_descriptors.extend(part)
        offset += len(part)
    return configuration


@contextlib.contextmanager
def _usb_errors() -> Iterator[None]:
    """Raise a bridge error as the pyusb error a libusb backend raises for it."""
    try:
        yield
    except DeviceBridgeError as error:
        if error.name == "stall":
            raise usb.core.USBError(str(error), errno=errno.EPIPE) from error
        if error.status == 504:
            raise usb.core.USBTimeoutError(str(error), errno=errno.ETIMEDOUT) from error
        raise usb.core.USBError(str(error), errno=errno.EIO) from error


class _BridgeBackend(usb.backend.IBackend):
    """pyusb's backend interface on a `DeviceBridgeClient`.

    A device is identified by its bridge name, which is also its handle.
    """

    def __init__(self, client: DeviceBridgeClient) -> None:
        self._client = client
        # name -> (device descriptor, configuration descriptors)
        self._descriptors: dict[str, tuple[SimpleNamespace, list[SimpleNamespace]]] = {}

    def _read_descriptors(self, record: dict) -> tuple[SimpleNamespace, list[SimpleNamespace]]:
        device = self._client.usb(record["name"])
        if not record["opened"]:
            device.open()
        try:
            head = _descriptor(
                _DEVICE, _DEVICE_FIELDS,
                device.control(_DEVICE_IN, _GET_DESCRIPTOR, _DT_DEVICE << 8, 0, _DEVICE.size),
                bus=_BUS, address=len(self._descriptors) + 1,
                port_number=None, port_numbers=None, speed=None,
            )
            configurations = []
            for index in range(head.bNumConfigurations):
                value = _DT_CONFIGURATION << 8 | index
                # The first 9 bytes carry wTotalLength, the size of the whole descriptor.
                short = device.control(_DEVICE_IN, _GET_DESCRIPTOR, value, 0, _CONFIGURATION.size)
                total = _CONFIGURATION.unpack(short)[2]
                configurations.append(_parse_configuration(
                    device.control(_DEVICE_IN, _GET_DESCRIPTOR, value, 0, total)))
        finally:
            if not record["opened"]:
                device.close()
        return head, configurations

    @_usb_errors()
    def enumerate_devices(self) -> list[str]:
        names = []
        for record in self._client.devices()["usb"]:
            if record["state"] != "attached":
                continue
            if record["name"] not in self._descriptors:
                self._descriptors[record["name"]] = self._read_descriptors(record)
            names.append(record["name"])
        return names

    def get_device_descriptor(self, dev: str) -> SimpleNamespace:
        return self._descriptors[dev][0]

    def get_configuration_descriptor(self, dev: str, config: int) -> SimpleNamespace:
        return self._descriptors[dev][1][config]

    def get_interface_descriptor(self, dev: str, intf: int, alt: int, config: int) -> SimpleNamespace:
        return self._descriptors[dev][1][config].interfaces[intf][alt]

    def get_endpoint_descriptor(self, dev: str, ep: int, intf: int, alt: int,
                                config: int) -> SimpleNamespace:
        return self._descriptors[dev][1][config].interfaces[intf][alt].endpoints[ep]

    @_usb_errors()
    def open_device(self, dev: str) -> str:
        self._client.usb(dev).open()
        return dev

    @_usb_errors()
    def close_device(self, dev_handle: str) -> None:
        self._client.usb(dev_handle).close()

    @_usb_errors()
    def set_configuration(self, dev_handle: str, config_value: int) -> None:
        self._client.usb(dev_handle).select_configuration(config_value)

    @_usb_errors()
    def get_configuration(self, dev_handle: str) -> int:
        return self._client.usb(dev_handle).control(_DEVICE_IN, _GET_CONFIGURATION, 0, 0, 1)[0]

    @_usb_errors()
    def set_interface_altsetting(self, dev_handle: str, intf: int, altsetting: int) -> None:
        self._client.usb(dev_handle).select_alternate(intf, altsetting)

    @_usb_errors()
    def claim_interface(self, dev_handle: str, intf: int) -> None:
        self._client.usb(dev_handle).claim_interface(intf)

    @_usb_errors()
    def release_interface(self, dev_handle: str, intf: int) -> None:
        self._client.usb(dev_handle).release_interface(intf)

    @_usb_errors()
    def bulk_write(self, dev_handle: str, ep: int, intf: int, data: array.array, timeout: int) -> int:
        return self._client.usb(dev_handle).transfer_out(ep & 0x7F, data.tobytes(), timeout)

    @_usb_errors()
    def bulk_read(self, dev_handle: str, ep: int, intf: int, buff: array.array, timeout: int) -> int:
        data = self._client.usb(dev_handle).transfer_in(ep & 0x7F, len(buff), timeout)
        buff[:len(data)] = array.array("B", data)
        return len(data)

    # WebUSB moves interrupt and bulk data through the same two calls.
    intr_write = bulk_write
    intr_read = bulk_read

    @_usb_errors()
    def ctrl_transfer(self, dev_handle: str, bmRequestType: int, bRequest: int, wValue: int,
                      wIndex: int, data: array.array, timeout: int) -> int:
        device = self._client.usb(dev_handle)
        if not bmRequestType & 0x80:
            return device.control(bmRequestType, bRequest, wValue, wIndex, data.tobytes(), timeout)
        received = device.control(bmRequestType, bRequest, wValue, wIndex, len(data), timeout)
        data[:len(received)] = array.array("B", received)
        return len(received)

    @_usb_errors()
    def clear_halt(self, dev_handle: str, ep: int) -> None:
        self._client.usb(dev_handle).clear_halt("in" if ep & 0x80 else "out", ep & 0x7F)

    @_usb_errors()
    def reset_device(self, dev_handle: str) -> None:
        self._client.usb(dev_handle).reset()

    def is_kernel_driver_active(self, dev_handle: str, intf: int) -> bool:
        # No kernel of this container has a driver on a device in the browser.
        return False


def get_backend(client: DeviceBridgeClient | None = None) -> usb.backend.IBackend:
    """A pyusb backend for the devices of one bridge.

    Args:
        client: The bridge to use; when omitted, the running Jupyter server is found
            as the `jupyterlab-device` CLI finds it.
    """
    return _BridgeBackend(client or DeviceBridgeClient())


def install(client: DeviceBridgeClient | None = None) -> usb.backend.IBackend:
    """Make the bridge the backend that pyusb hands out by default.

    After this call `usb.core.find` without a backend argument, and
    `libusb_package.find` and `libusb_package.get_libusb1_backend` where that
    package is installed, use the bridge. Call it before the program's first search.

    Returns:
        The installed backend.
    """
    backend = get_backend(client)
    # usb.core.find asks the libusb1 module first; libusb_package asks it too.
    usb.backend.libusb1.get_backend = lambda find_library=None: backend
    try:
        import libusb_package
    except ImportError:
        return backend
    libusb_package.get_libusb1_backend = lambda: backend
    return backend
