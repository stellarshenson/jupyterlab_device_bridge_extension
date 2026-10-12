"""USB relay: the record of one USB device and the plan of one operation on it.

The browser tab runs every operation through WebUSB. The server only passes the
operation and its arguments to the tab that holds the device and returns the answer.
"""

from dataclasses import dataclass, field

OPS = (
    "open", "close", "select-configuration", "claim-interface", "release-interface",
    "select-alternate", "control-in", "control-out", "transfer-in", "transfer-out",
    "clear-halt", "reset",
)
# What the server waits beyond the timeout of a transfer in. The tab ends that wait
# itself and keeps the transfer for the next call; its answer must arrive first, or
# data that came in at the last moment would go to nobody.
ACK_GRACE_S = 0.5


@dataclass
class UsbDevice:
    """One USB device in the server's table."""

    name: str
    vendor_id: int
    product_id: int
    product_name: str | None = None
    manufacturer_name: str | None = None
    serial_number: str | None = None
    tab: str | None = None
    opened: bool = False
    holder: dict | None = None  # {name} of the program that opened the device
    rx: int = 0
    tx: int = 0
    error: str | None = None
    descriptors: dict = field(init=False)

    def __post_init__(self) -> None:
        # What the claim told, until the tab sends the descriptors.
        self.descriptors = {
            "vendorId": self.vendor_id, "productId": self.product_id,
            "manufacturerName": self.manufacturer_name, "productName": self.product_name,
            "serialNumber": self.serial_number, "configurations": [], "opened": False,
        }

    def attach(self, tab_id: str) -> None:
        """A tab holds the device now."""
        self.tab = tab_id
        self.error = None

    def detach(self, error: str | None = None) -> None:
        """No tab holds the device any more; `error` says why when it was not the user."""
        self.tab = None
        self.set_opened(False)
        self.error = error

    def grant(self) -> dict:
        """The fields of the `claimed` answer for this device."""
        return {"name": self.name}

    def set_descriptors(self, descriptors: dict) -> None:
        """Take the descriptors the tab read from the device."""
        self.descriptors = descriptors
        self.opened = bool(descriptors.get("opened"))
        if not self.opened:
            self.holder = None

    def set_opened(self, opened: bool, program: str | None = None) -> None:
        """The device is open or closed in the browser now; the descriptors say the same.

        Args:
            opened: Whether the device is open.
            program: Name of the program that opened it, when the caller told one.
        """
        self.opened = opened
        self.descriptors["opened"] = opened
        self.holder = {"name": program} if opened and program else None

    def record(self) -> dict:
        """The USB record of docs/design.md."""
        return {
            "name": self.name, "state": "attached" if self.tab else "detached", "tab": self.tab,
            "vendorId": self.vendor_id, "productId": self.product_id,
            "productName": self.product_name, "manufacturerName": self.manufacturer_name,
            "serialNumber": self.serial_number, "opened": self.opened, "holder": self.holder,
            "rx": self.rx, "tx": self.tx, "error": self.error,
        }


def take_program(op: str, body: dict) -> str | None:
    """Take the program name out of the body of an `open`; it is no argument of WebUSB.

    Args:
        op: The operation of the request.
        body: Body of `POST usb/<name>/<op>`; `program` is removed from it for an `open`.

    Returns:
        The name of the calling program, None when the body names none.

    Raises:
        ValueError: `program` is not a text, or it is empty.
    """
    if op != "open" or "program" not in body:
        return None
    program = body.pop("program")
    if not isinstance(program, str) or not program.strip():
        raise ValueError("program: a text that is not empty")
    return program


def plan(op: str, body: dict, default_s: float) -> tuple[dict, float]:
    """The arguments of one operation for the tab and the time to wait for its answer.

    Args:
        op: One of `OPS`.
        body: Body of `POST usb/<name>/<op>`: the arguments in WebUSB's parameter
            names, and `timeout` in ms.
        default_s: Seconds to wait when the body names no timeout.

    Returns:
        `(args, seconds)`. Only a transfer in keeps a `timeout` in its arguments.

    Raises:
        ValueError: The operation is unknown or the timeout is not a number of ms.
    """
    if op not in OPS:
        raise ValueError(f"unknown USB operation {op}; the operations are {', '.join(OPS)}")
    args = dict(body)
    timeout_ms = args.pop("timeout", None)
    if timeout_ms is not None and (type(timeout_ms) not in (int, float) or timeout_ms < 0):
        raise ValueError(f"timeout: {timeout_ms!r} is not a number of milliseconds")
    seconds = timeout_ms / 1000 if timeout_ms else default_s
    if op == "transfer-in":
        args["timeout"] = round(seconds * 1000)
        seconds += ACK_GRACE_S
    return args, seconds
