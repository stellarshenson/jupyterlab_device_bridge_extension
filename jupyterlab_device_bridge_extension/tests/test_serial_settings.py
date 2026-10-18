"""Tests of the serial settings: the system configs, the check of a change, the defaults and the saved configs."""

import json
import pathlib

import pytest

from jupyterlab_device_bridge_extension import serial_settings

# The settings schema of the lab plugin. A wheel carries this file without the schema
# beside the package, so outside a source checkout the test that reads it is skipped.
SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "schema" / "plugin.json"
# The default serial settings of the schema and the settings field each one sets.
DEFAULT_SETTINGS = {"defaultBaudRate": "baudRate", "defaultDataBits": "dataBits", "defaultParity": "parity",
                    "defaultStopBits": "stopBits", "defaultOnOpen": "onOpen"}


def test_acc_prof_203_the_system_configs():
    """ACC-PROF-203 the system delivers six read-only configs with their settings and their action on open."""
    by_id = {item["id"]: item for item in serial_settings.SYSTEM_CONFIGS}

    assert list(by_id) == ["default", "monitor", "arduino-upload", "arduino-isp", "stm32-bootloader", "esp-upload"]
    for item in serial_settings.SYSTEM_CONFIGS:
        assert set(item) == {"id", "name", "system", *serial_settings.ALL_FIELDS}
        assert item["system"] is True and item["name"]

    def frame(config_id):
        item = by_id[config_id]
        return item["baudRate"], item["dataBits"], item["parity"], item["stopBits"]

    assert frame("default") == (115200, 8, "none", 1) and by_id["default"]["onOpen"] == "none"
    assert frame("monitor") == (115200, 8, "none", 1) and by_id["monitor"]["onOpen"] == "none"
    assert frame("arduino-upload") == (115200, 8, "none", 1)
    assert by_id["arduino-upload"]["onOpen"] == "pulse-dtr"
    assert frame("arduino-isp") == (19200, 8, "none", 1) and by_id["arduino-isp"]["onOpen"] == "none"
    assert frame("stm32-bootloader") == (115200, 8, "even", 1)
    assert by_id["stm32-bootloader"]["onOpen"] == "none"
    assert frame("esp-upload") == (115200, 8, "none", 1)
    assert by_id["esp-upload"]["onOpen"] == "esp-bootloader"
    assert serial_settings.DEFAULT_SETTINGS == {
        "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"}
    assert serial_settings.ACTIONS == ("none", "pulse-dtr", "pulse-rts", "esp-bootloader", "touch-1200")


@pytest.mark.parametrize("change, field", [
    ({"onOpen": "pulse-cts"}, "onOpen"),
    ({"parity": "mark"}, "parity"),
    ({"dataBits": 9}, "dataBits"),
    ({"dataBits": "8"}, "dataBits"),
    ({"dataBits": 7.0}, "dataBits"),
    ({"stopBits": 3}, "stopBits"),
    ({"stopBits": True}, "stopBits"),
    ({"baudRate": 0}, "baudRate"),
    ({"baudRate": "115200"}, "baudRate"),
    ({"baudRate": True}, "baudRate"),
    # DEF-SERIAL-12: the speed of the pty is a 32-bit field.
    ({"baudRate": serial_settings.MAX_BAUD + 1}, "baudRate"),
    ({"baud": 9600}, "baud"),
])
def test_acc_prof_32_a_refused_value_names_its_field(change, field):
    """ACC-PROF-32 an action, parity or bit count outside its choices is refused and the message names the field."""
    with pytest.raises(serial_settings.SettingsError, match=f"^{field}: "):
        serial_settings.validate_change(change)


def test_acc_prof_32_allowed_values_pass():
    """ACC-PROF-32 the check refuses nothing that the design allows."""
    for item in serial_settings.SYSTEM_CONFIGS:
        assert serial_settings.validate_change(
            {field: item[field] for field in serial_settings.ALL_FIELDS})
    for action in serial_settings.ACTIONS:
        assert serial_settings.validate_change({"onOpen": action})
    change = {"baudRate": 250000, "dataBits": 7, "parity": "odd", "stopBits": 2}
    assert serial_settings.validate_change(change) == change
    for baud in (1, serial_settings.MAX_BAUD):
        assert serial_settings.validate_change({"baudRate": baud})


@pytest.mark.skipif(not SCHEMA.is_file(), reason="no settings schema to read outside a source checkout")
def test_acc_prof_121_the_default_settings_of_the_schema_equal_the_built_in_values_and_the_choices_of_the_server():
    """ACC-PROF-121 the five default serial settings of schema/plugin.json have the built-in values as defaults and the choices of serial_settings.py as enums."""
    properties = json.loads(SCHEMA.read_text(encoding="utf-8"))["properties"]

    assert {name for name in properties if name.startswith("default")} == set(DEFAULT_SETTINGS)
    for name, field in DEFAULT_SETTINGS.items():
        assert properties[name]["default"] == serial_settings.DEFAULT_SETTINGS[field], f"the default of {name}"
        assert type(properties[name]["default"]) is type(serial_settings.DEFAULT_SETTINGS[field]), f"the type of the default of {name}"
        if field == "baudRate":
            # Any whole number from 1 to MAX_BAUD, as `validate_change` takes it.
            assert (properties[name]["type"], properties[name]["minimum"]) == ("integer", 1)
            assert properties[name]["maximum"] == serial_settings.MAX_BAUD
            assert "enum" not in properties[name] and "oneOf" not in properties[name]
        else:
            values = tuple(choice["const"] for choice in properties[name]["oneOf"])
            assert values == serial_settings.CHOICES[field], f"the choices of {name}"


@pytest.mark.skipif(not SCHEMA.is_file(), reason="no settings schema to read outside a source checkout")
def test_acc_prof_123_each_choice_of_the_schema_is_a_value_of_the_server_with_a_title():
    """ACC-PROF-123 the four default settings with fixed values offer their choices as oneOf entries with const and title, and no enum: the Settings Editor then shows the title and stores the const."""
    properties = json.loads(SCHEMA.read_text(encoding="utf-8"))["properties"]
    kinds = {"integer": int, "string": str}

    for name, field in DEFAULT_SETTINGS.items():
        if field == "baudRate":
            continue
        setting = properties[name]
        assert "enum" not in setting, f"{name} offers raw values"
        assert len(setting["oneOf"]) == len(serial_settings.CHOICES[field])
        for choice in setting["oneOf"]:
            assert set(choice) == {"const", "title"}, f"a choice of {name}"
            assert type(choice["const"]) is kinds[setting["type"]], f"the type of {choice['const']!r} of {name}"
            assert type(choice["title"]) is str and choice["title"].strip(), f"the title of {choice['const']!r}"
            # A value the server refuses would be refused with every claim of the lab.
            assert serial_settings.validate_change({field: choice["const"]})
        assert setting["default"] in [choice["const"] for choice in setting["oneOf"]]
        titles = [choice["title"] for choice in setting["oneOf"]]
        assert len(set(titles)) == len(titles), f"two choices of {name} have one title"
        if setting["type"] == "integer":
            assert titles == [str(choice["const"]) for choice in setting["oneOf"]]


@pytest.mark.parametrize("defaults, values", [
    ({}, {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"}),
    ({"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"},
     {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"}),
    ({"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2, "onOpen": "pulse-dtr"},
     {"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2, "onOpen": "pulse-dtr"}),
    ({"baudRate": 115200, "parity": "odd"},
     {"baudRate": 115200, "dataBits": 8, "parity": "odd", "stopBits": 1, "onOpen": "none"}),
])
def test_acc_prof_203_the_defaults_of_the_lab_fill_a_new_port(defaults, values):
    """ACC-PROF-203 the default serial settings give all five values of a new port, over the built-in values."""
    assert serial_settings.default_values(defaults) == values


@pytest.mark.parametrize("defaults, field", [
    ({"baud": 9600}, "baud"),
    ({"baudRate": 0}, "baudRate"),
    ({"baudRate": serial_settings.MAX_BAUD + 1}, "baudRate"),
    ({"parity": "mark"}, "parity"),
    ({"onOpen": "pulse-cts"}, "onOpen"),
    ([], "defaults"),
    (None, "defaults"),
])
def test_acc_prof_120_refused_default_settings_name_their_field(defaults, field):
    """ACC-PROF-120 default settings that are no object, name an unknown field, or hold a value outside the choices are refused, and the message names the field."""
    with pytest.raises(serial_settings.SettingsError, match=f"^{field}: "):
        serial_settings.default_values(defaults)


def test_acc_prof_205_a_name_is_a_text_of_1_to_64_characters():
    """ACC-PROF-205 a name loses its surrounding spaces; an empty name, a long name and a control character are refused."""
    assert serial_settings.validate_name(" My board ") == "My board"
    assert serial_settings.same_name("My Board", "my board")
    for bad in ("", " ", "a" * 65, "x\x00y", "x\ty", 3):
        with pytest.raises(serial_settings.SettingsError, match="^name: "):
            serial_settings.validate_name(bad)


def test_acc_prof_205_saved_configs_round_trip_and_are_private(tmp_path):
    """ACC-PROF-205 the saved configs are written mode 0600 and read back; a missing file is empty and a file that is no config list is refused."""
    path = tmp_path / "serial-settings.json"
    configs = [{"id": "config-0123abcd", "name": "My board", "system": False,
                **serial_settings.DEFAULT_SETTINGS}]

    serial_settings.save_saved(path, configs)

    assert serial_settings.load_saved(path) == configs
    assert path.stat().st_mode & 0o777 == 0o600
    assert serial_settings.load_saved(tmp_path / "none.json") == []
    path.write_text("{}", encoding="utf-8")
    with pytest.raises(serial_settings.SettingsError, match="not a file of saved serial settings"):
        serial_settings.load_saved(path)
