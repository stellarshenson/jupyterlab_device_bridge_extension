"""Serial profiles: the settings a port is opened with and the action run when a tool opens the device.

A device has one profile id and optional overrides of single fields. `resolve` gives
the fields that apply; `validate_change` checks the body of `PUT serial/<name>/profile`;
`default_overrides` turns the default serial settings of a lab into the overrides of a
new port.
"""

ACTIONS = ("none", "pulse-dtr", "pulse-rts", "esp-bootloader", "touch-1200")
SETTING_FIELDS = ("baudRate", "dataBits", "parity", "stopBits")
DEFAULT_PROFILE = "monitor"
# The highest baud rate: the speed of the pty is a 32-bit field (vserial.py), and so is the
# baud rate of Web Serial.
MAX_BAUD = 0xFFFFFFFF

PROFILES = [
    {"id": "monitor", "label": "Monitor", "baudRate": 115200, "dataBits": 8,
     "parity": "none", "stopBits": 1, "onOpen": "none"},
    {"id": "arduino-upload", "label": "Arduino upload", "baudRate": 115200, "dataBits": 8,
     "parity": "none", "stopBits": 1, "onOpen": "pulse-dtr"},
    {"id": "arduino-isp", "label": "Arduino as ISP", "baudRate": 19200, "dataBits": 8,
     "parity": "none", "stopBits": 1, "onOpen": "none"},
    {"id": "stm32-bootloader", "label": "STM32 bootloader", "baudRate": 115200, "dataBits": 8,
     "parity": "even", "stopBits": 1, "onOpen": "none"},
    {"id": "esp-upload", "label": "ESP upload", "baudRate": 115200, "dataBits": 8,
     "parity": "none", "stopBits": 1, "onOpen": "esp-bootloader"},
]
_BY_ID = {profile["id"]: profile for profile in PROFILES}

# The values each field of a profile change may have; baudRate is any whole number from 1 to
# MAX_BAUD. The default serial settings in schema/plugin.json of the lab plugin offer the same
# values.
CHOICES = {
    "profile": tuple(_BY_ID),
    "dataBits": (7, 8),
    "parity": ("none", "even", "odd"),
    "stopBits": (1, 2),
    "onOpen": ACTIONS,
}


class ProfileError(ValueError):
    """A profile change that is refused; the message starts with the name of the field."""


def validate_change(change: dict) -> dict:
    """Check the body of a profile change.

    Args:
        change: `{profile?, baudRate?, dataBits?, parity?, stopBits?, onOpen?}`.

    Returns:
        The same change.

    Raises:
        ProfileError: A field is unknown or its value is not allowed.
    """
    for field, value in change.items():
        if field == "baudRate":
            if type(value) is not int or not 0 < value <= MAX_BAUD:
                raise ProfileError(f"baudRate: {value!r} is not a whole number from 1 to {MAX_BAUD}")
            continue
        if field not in CHOICES:
            raise ProfileError(
                f"{field}: not a profile field; the fields are baudRate, {', '.join(CHOICES)}")
        choices = CHOICES[field]
        # The type is compared too: in Python True equals 1 and 7.0 equals 7.
        if not any(value == choice and type(value) is type(choice) for choice in choices):
            raise ProfileError(
                f"{field}: {value!r} is not one of {', '.join(map(str, choices))}")
    return change


def default_overrides(defaults: object) -> dict:
    """The overrides that give a new port of the default profile the default serial settings of a lab.

    Args:
        defaults: `{baudRate?, dataBits?, parity?, stopBits?, onOpen?}`, as a tab sent it with a claim.

    Returns:
        The fields whose value differs from the default profile.

    Raises:
        ProfileError: `defaults` is not an object, names a profile id or an unknown
            field, or holds a value that the field does not take.
    """
    if not isinstance(defaults, dict):
        raise ProfileError(f"defaults: {defaults!r} is not an object")
    if "profile" in defaults:
        raise ProfileError("profile: default settings name no profile; a new port gets the profile "
                           f"{DEFAULT_PROFILE}")
    validate_change(defaults)
    profile = _BY_ID[DEFAULT_PROFILE]
    return {field: value for field, value in defaults.items() if value != profile[field]}


def resolve(profile_id: str, overrides: dict) -> dict:
    """The fields of a built-in profile with a device's overrides applied.

    Args:
        profile_id: Id of a built-in profile.
        overrides: Single fields that replace the profile's.

    Returns:
        `{id, label, baudRate, dataBits, parity, stopBits, onOpen}`.
    """
    return {**_BY_ID[profile_id], **overrides}
