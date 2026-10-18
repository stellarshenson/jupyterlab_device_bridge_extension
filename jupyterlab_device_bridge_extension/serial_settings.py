"""Serial settings: the values a port is opened with, the action on open, and the named configs.

A port has one settings record: baud rate, data bits, parity, stop bits and the action
run when a tool opens its virtual device. The system ships six read-only configs; the first,
`default`, holds the built-in values, so a port can always return to them. The user can save
the current values of a port under a name. Saved configs live in `serial-settings.json`
under the Jupyter data directory, so they survive a server restart.

The module validates a settings change, combines a lab's default values with the built-in
ones, and reads and writes the file of saved configs.
"""

import contextlib
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

ACTIONS = ("none", "pulse-dtr", "pulse-rts", "esp-bootloader", "touch-1200")
SETTING_FIELDS = ("baudRate", "dataBits", "parity", "stopBits")
ALL_FIELDS = (*SETTING_FIELDS, "onOpen")
# The highest baud rate: the speed of the pty is a 32-bit field (vserial.py), and so is
# the baud rate of Web Serial.
MAX_BAUD = 0xFFFFFFFF

DEFAULT_SETTINGS = {
    "baudRate": 115200,
    "dataBits": 8,
    "parity": "none",
    "stopBits": 1,
    "onOpen": "none",
}

# The settings the system delivers. They are read-only: a user saves a config under another
# name, and deleting one of these is refused. `default` comes first and holds the built-in
# values, so a port with those values names it rather than another config that matches.
SYSTEM_CONFIGS = [
    {"id": "default", "name": "Default", "system": True, **DEFAULT_SETTINGS},
    {"id": "monitor", "name": "Monitor", "system": True, **DEFAULT_SETTINGS},
    {"id": "arduino-upload", "name": "Arduino upload", "system": True,
     "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1,
     "onOpen": "pulse-dtr"},
    {"id": "arduino-isp", "name": "Arduino as ISP", "system": True,
     "baudRate": 19200, "dataBits": 8, "parity": "none", "stopBits": 1,
     "onOpen": "none"},
    {"id": "stm32-bootloader", "name": "STM32 bootloader", "system": True,
     "baudRate": 115200, "dataBits": 8, "parity": "even", "stopBits": 1,
     "onOpen": "none"},
    {"id": "esp-upload", "name": "ESP upload", "system": True,
     "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1,
     "onOpen": "esp-bootloader"},
]

# The values each field of a change may have; the default serial settings in
# schema/plugin.json of the lab plugin offer the same values.
CHOICES = {
    "dataBits": (7, 8),
    "parity": ("none", "even", "odd"),
    "stopBits": (1, 2),
    "onOpen": ACTIONS,
}
# A name of a saved config: 1 to 64 characters, no control characters.
NAME_RE = re.compile(r"[^\x00-\x1f\x7f]{1,64}")


class SettingsError(ValueError):
    """A settings change or a saved config that is refused; the message names the reason."""


def validate_change(change: dict) -> dict:
    """Check the body of a settings change.

    Args:
        change: `{baudRate?, dataBits?, parity?, stopBits?, onOpen?}`.

    Returns:
        The same change.

    Raises:
        SettingsError: A field is unknown or its value is not allowed.
    """
    for field, value in change.items():
        if field == "baudRate":
            if type(value) is not int or not 0 < value <= MAX_BAUD:
                raise SettingsError(
                    f"baudRate: {value!r} is not a whole number from 1 to {MAX_BAUD}")
            continue
        if field not in CHOICES:
            raise SettingsError(
                f"{field}: not a serial setting; the settings are baudRate, {', '.join(CHOICES)}")
        choices = CHOICES[field]
        # The type is compared too: in Python True equals 1 and 7.0 equals 7.
        if not any(value == choice and type(value) is type(choice) for choice in choices):
            raise SettingsError(
                f"{field}: {value!r} is not one of {', '.join(map(str, choices))}")
    return change


def default_values(defaults: object) -> dict:
    """The settings of a new port: the defaults of the lab over the built-in values.

    Args:
        defaults: `{baudRate?, dataBits?, parity?, stopBits?, onOpen?}`, as a tab sent it with a claim.

    Returns:
        All five fields.

    Raises:
        SettingsError: `defaults` is not an object, names an unknown field, or holds a
            value that the field does not take.
    """
    if not isinstance(defaults, dict):
        raise SettingsError(f"defaults: {defaults!r} is not an object")
    validate_change(defaults)
    return {**DEFAULT_SETTINGS, **defaults}


def matching_config_id(values: dict) -> str | None:
    """The id of the first system config whose five values equal `values`, or None.

    The configs are searched in their order, and `default` comes first, so the built-in
    values name `default` also while other system configs hold the same values.
    """
    for config in SYSTEM_CONFIGS:
        if all(config[field] == values.get(field) for field in ALL_FIELDS):
            return config["id"]
    return None


def validate_name(name: object) -> str:
    """Check the name of a saved config and return it without surrounding spaces.

    Raises:
        SettingsError: The name is not a text of 1 to 64 characters without control characters.
    """
    if not isinstance(name, str):
        raise SettingsError(f"name: {name!r} is not a text")
    text = name.strip()
    if not NAME_RE.fullmatch(text):
        raise SettingsError("name: 1 to 64 characters, no control characters")
    return text


def same_name(first: str, second: str) -> bool:
    """Whether two names of saved configs name the same config; the comparison ignores case."""
    return first.casefold() == second.casefold()


def settings_file(data_dir: str | os.PathLike | None = None) -> Path:
    """The file of the saved configs: `serial-settings.json` in the Jupyter data directory."""
    if data_dir is None:
        from jupyter_core.paths import jupyter_data_dir

        data_dir = jupyter_data_dir()
    return Path(data_dir) / "jupyterlab-device-bridge" / "serial-settings.json"


def load_saved(path: Path) -> list[dict]:
    """The user-saved configs of `path`; an empty list when the file does not exist.

    Raises:
        OSError: The file cannot be read.
        SettingsError: The file is not JSON, or holds no list of configs.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    if not isinstance(document, dict) or not isinstance(document.get("configs"), list):
        raise SettingsError(f"{path}: not a file of saved serial settings")
    saved = []
    for item in document["configs"]:
        if not isinstance(item, dict):
            raise SettingsError(f"{path}: a saved config is not an object")
        name = validate_name(item.get("name"))
        values = {field: item.get(field) for field in ALL_FIELDS}
        if any(value is None for value in values.values()):
            raise SettingsError(f"{path}: {name}: a setting is missing")
        validate_change(values)
        saved.append({"id": str(item.get("id") or new_id()), "name": name,
                      "system": False, **values})
    return saved


def save_saved(path: Path, configs: list[dict]) -> None:
    """Write the user-saved configs to `path`, mode 0600, replacing the file in one step."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".serial-settings-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"configs": configs}, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def new_id() -> str:
    """An id for a user-saved config; unique enough for a personal lab."""
    return "config-" + uuid.uuid4().hex[:8]
