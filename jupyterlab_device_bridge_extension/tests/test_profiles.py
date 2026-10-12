"""Tests of the built-in serial profiles, of the check of a profile change and of the default serial settings."""

import json
import pathlib

import pytest

from jupyterlab_device_bridge_extension import profiles

# The settings schema of the lab plugin. A wheel carries this file without the schema
# beside the package, so outside a source checkout the test that reads it is skipped.
SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "schema" / "plugin.json"
# The default serial settings of the schema and the profile field each one sets.
DEFAULT_SETTINGS = {"defaultBaudRate": "baudRate", "defaultDataBits": "dataBits", "defaultParity": "parity",
                    "defaultStopBits": "stopBits", "defaultOnOpen": "onOpen"}


def test_acc_prof_22_five_built_in_profiles():
    """ACC-PROF-22 the five built-in profiles exist with their settings and their action on open."""
    by_id = {profile["id"]: profile for profile in profiles.PROFILES}

    assert list(by_id) == ["monitor", "arduino-upload", "arduino-isp", "stm32-bootloader", "esp-upload"]
    for profile in profiles.PROFILES:
        assert set(profile) == {"id", "label", "baudRate", "dataBits", "parity", "stopBits", "onOpen"}
        assert profile["label"]

    def frame(profile_id):
        profile = by_id[profile_id]
        return profile["baudRate"], profile["dataBits"], profile["parity"], profile["stopBits"]

    assert frame("monitor") == (115200, 8, "none", 1) and by_id["monitor"]["onOpen"] == "none"
    assert frame("arduino-upload") == (115200, 8, "none", 1)
    assert by_id["arduino-upload"]["onOpen"] == "pulse-dtr"
    assert frame("arduino-isp") == (19200, 8, "none", 1) and by_id["arduino-isp"]["onOpen"] == "none"
    assert frame("stm32-bootloader") == (115200, 8, "even", 1)
    assert by_id["stm32-bootloader"]["onOpen"] == "none"
    assert frame("esp-upload") == (115200, 8, "none", 1)
    assert by_id["esp-upload"]["onOpen"] == "esp-bootloader"
    assert profiles.DEFAULT_PROFILE == "monitor"
    assert profiles.ACTIONS == ("none", "pulse-dtr", "pulse-rts", "esp-bootloader", "touch-1200")


@pytest.mark.parametrize("change, field", [
    ({"profile": "arduino"}, "profile"),
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
    ({"baudRate": profiles.MAX_BAUD + 1}, "baudRate"),
    ({"baud": 9600}, "baud"),
])
def test_acc_prof_32_a_refused_value_names_its_field(change, field):
    """ACC-PROF-32 an unknown profile id, action, parity or bit count is refused and the message names the field."""
    with pytest.raises(profiles.ProfileError, match=f"^{field}: "):
        profiles.validate_change(change)


def test_acc_prof_32_allowed_values_pass():
    """ACC-PROF-32 the check refuses nothing that the design allows."""
    for profile in profiles.PROFILES:
        assert profiles.validate_change({"profile": profile["id"]})
    for action in profiles.ACTIONS:
        assert profiles.validate_change({"onOpen": action})
    change = {"baudRate": 250000, "dataBits": 7, "parity": "odd", "stopBits": 2}
    assert profiles.validate_change(change) == change
    for baud in (1, profiles.MAX_BAUD):
        assert profiles.validate_change({"baudRate": baud})


def test_acc_prof_22_overrides_replace_single_fields():
    """ACC-PROF-22 a device's overrides replace single fields of its profile and leave the rest."""
    resolved = profiles.resolve("stm32-bootloader", {"baudRate": 57600, "onOpen": "pulse-rts"})

    assert (resolved["baudRate"], resolved["parity"], resolved["onOpen"]) == (57600, "even", "pulse-rts")
    assert profiles.resolve("stm32-bootloader", {})["baudRate"] == 115200


@pytest.mark.skipif(not SCHEMA.is_file(), reason="no settings schema to read outside a source checkout")
def test_acc_prof_121_the_default_settings_of_the_schema_equal_profile_monitor_and_the_choices_of_the_server():
    """ACC-PROF-121 the five default serial settings of schema/plugin.json have the values of profile monitor as defaults and the choices of profiles.py as enums."""
    properties = json.loads(SCHEMA.read_text(encoding="utf-8"))["properties"]
    monitor = profiles.resolve(profiles.DEFAULT_PROFILE, {})

    assert {name for name in properties if name.startswith("default")} == set(DEFAULT_SETTINGS)
    for name, field in DEFAULT_SETTINGS.items():
        assert properties[name]["default"] == monitor[field], f"the default of {name}"
        assert type(properties[name]["default"]) is type(monitor[field]), f"the type of the default of {name}"
        if field == "baudRate":
            # Any whole number from 1 to MAX_BAUD, as `validate_change` takes it.
            assert (properties[name]["type"], properties[name]["minimum"]) == ("integer", 1)
            assert properties[name]["maximum"] == profiles.MAX_BAUD
            assert "enum" not in properties[name] and "oneOf" not in properties[name]
        else:
            values = tuple(choice["const"] for choice in properties[name]["oneOf"])
            assert values == profiles.CHOICES[field], f"the choices of {name}"


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
        assert len(setting["oneOf"]) == len(profiles.CHOICES[field])
        for choice in setting["oneOf"]:
            assert set(choice) == {"const", "title"}, f"a choice of {name}"
            assert type(choice["const"]) is kinds[setting["type"]], f"the type of {choice['const']!r} of {name}"
            assert type(choice["title"]) is str and choice["title"].strip(), f"the title of {choice['const']!r}"
            # A value the server refuses would be refused with every claim of the lab.
            assert profiles.validate_change({field: choice["const"]})
        assert setting["default"] in [choice["const"] for choice in setting["oneOf"]]
        titles = [choice["title"] for choice in setting["oneOf"]]
        assert len(set(titles)) == len(titles), f"two choices of {name} have one title"
        if setting["type"] == "integer":
            assert titles == [str(choice["const"]) for choice in setting["oneOf"]]


@pytest.mark.parametrize("defaults, overrides", [
    ({}, {}),
    ({"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "onOpen": "none"}, {}),
    ({"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2, "onOpen": "pulse-dtr"},
     {"baudRate": 9600, "dataBits": 7, "parity": "even", "stopBits": 2, "onOpen": "pulse-dtr"}),
    ({"baudRate": 115200, "parity": "odd"}, {"parity": "odd"}),
])
def test_acc_prof_118_default_settings_become_the_overrides_that_differ_from_profile_monitor(defaults, overrides):
    """ACC-PROF-118 the default serial settings give the overrides of profile monitor: only the fields whose value differs."""
    assert profiles.default_overrides(defaults) == overrides


@pytest.mark.parametrize("defaults, field", [
    ({"profile": "monitor"}, "profile"),
    ({"baud": 9600}, "baud"),
    ({"baudRate": 0}, "baudRate"),
    ({"baudRate": profiles.MAX_BAUD + 1}, "baudRate"),
    ({"parity": "mark"}, "parity"),
    ({"onOpen": "pulse-cts"}, "onOpen"),
    ([], "defaults"),
    (None, "defaults"),
])
def test_acc_prof_120_refused_default_settings_name_their_field(defaults, field):
    """ACC-PROF-120 default settings that are no object, name a profile id or an unknown field, or hold a value outside the choices are refused, and the message names the field."""
    with pytest.raises(profiles.ProfileError, match=f"^{field}: "):
        profiles.default_overrides(defaults)
