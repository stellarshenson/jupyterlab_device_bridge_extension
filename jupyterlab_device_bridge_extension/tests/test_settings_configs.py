"""Tests of the saved serial settings configs: applying, saving and deleting them over the REST API."""

import json
import pathlib

from jupyterlab_device_bridge_extension import serial_settings
from jupyterlab_device_bridge_extension.tests.fake_tab import SERIAL_NAME

from .test_cli import Outcome, cli_run, lab  # noqa: F401 - fixtures
from .test_client import attach_serial
from .test_manager import record

ESP_UPLOAD = {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1,
              "onOpen": "esp-bootloader"}


async def test_acc_prof_206_the_list_holds_the_system_configs_first(api):
    """ACC-PROF-206 the list holds the six system configs first, read-only, and then the saved configs."""
    status, document = await api("GET", "settings-configs")

    assert status == 200
    assert [item["id"] for item in document["configs"][:6]] == [
        "default", "monitor", "arduino-upload", "arduino-isp", "stm32-bootloader", "esp-upload"]
    assert [item["system"] for item in document["configs"][:6]] == [True] * 6
    assert all(item["system"] is False for item in document["configs"][6:])


async def test_acc_prof_219_the_default_config_restores_the_built_in_values(api, fake_tab, cli_run):
    """ACC-PROF-219 Default holds the built-in values: settings list shows it first, applying it after a change restores 115200 8N1 with no action, and deleting it or saving a config named Default is refused."""
    await attach_serial(fake_tab)

    listed = await cli_run("settings", "list")
    first = listed.out.decode().splitlines()[0]
    assert (listed.status, listed.err) == (0, "")
    assert first.startswith("Default") and first.endswith("system")

    changed = await api("PUT", "serial", SERIAL_NAME, "settings",
                        body={"baudRate": 57600, "parity": "even", "onOpen": "pulse-dtr"})
    assert changed[1]["config"] is None, "changing fields makes the port custom"
    status, record = await api("PUT", "serial", SERIAL_NAME, "settings",
                               body={"config": "default"})

    assert (status, record["config"], record["configName"]) == (200, "default", "Default")
    assert record["configured"] == serial_settings.DEFAULT_SETTINGS
    assert record["settings"] == {
        "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1}

    refused_delete = await api("DELETE", "settings-configs", "default")
    refused_save = await api("POST", "settings-configs", body={
        "name": "Default", **serial_settings.DEFAULT_SETTINGS})

    assert refused_delete[0] == 409
    assert refused_save[0] == 409


async def test_acc_prof_204_apply_a_system_config_then_change_one_field(api, fake_tab):
    """ACC-PROF-204 applying a config copies its five values and names it; changing one field makes the port custom and keeps the other values."""
    await attach_serial(fake_tab)

    status, record = await api("PUT", "serial", SERIAL_NAME, "settings",
                               body={"config": "esp-upload"})
    assert (status, record["config"], record["configName"]) == (200, "esp-upload", "ESP upload")
    assert record["configured"] == ESP_UPLOAD
    assert record["settings"] == {field: ESP_UPLOAD[field] for field in
                                  ("baudRate", "dataBits", "parity", "stopBits")}

    status, record = await api("PUT", "serial", SERIAL_NAME, "settings",
                               body={"baudRate": 57600})

    assert status == 200
    assert (record["config"], record["configName"]) == (None, None)
    assert record["configured"] == {**ESP_UPLOAD, "baudRate": 57600}


async def test_acc_prof_205_a_saved_config_is_written_and_read_back(
        api, fake_tab, settings_file, cli_run):
    """ACC-PROF-205 saving the values of a port writes the file of the configs; a duplicate name and a system name or id are refused, and the system config still applies by id."""
    tab, _ = await attach_serial(fake_tab)
    await api("PUT", "serial", SERIAL_NAME, "settings",
              body={"baudRate": 57600, "onOpen": "pulse-rts"})

    status, saved = await api("POST", "settings-configs", body={
        "name": " My board ", "baudRate": 57600, "dataBits": 8, "parity": "none",
        "stopBits": 1, "onOpen": "pulse-rts"})

    assert (status, saved["name"], saved["system"]) == (200, "My board", False)
    path = pathlib.Path(settings_file)
    document = json.loads(path.read_text(encoding="utf-8"))
    assert [(item["id"], item["name"]) for item in document["configs"]] == [
        (saved["id"], "My board")]
    assert path.stat().st_mode & 0o777 == 0o600

    duplicate = await api("POST", "settings-configs", body={
        "name": "my board", "baudRate": 9600, "dataBits": 8, "parity": "none",
        "stopBits": 1, "onOpen": "none"})
    system = await api("POST", "settings-configs", body={
        "name": "Monitor", "baudRate": 9600, "dataBits": 8, "parity": "none",
        "stopBits": 1, "onOpen": "none"})
    system_id = await api("POST", "settings-configs", body={
        "name": "esp-upload", "baudRate": 9600, "dataBits": 8, "parity": "none",
        "stopBits": 1, "onOpen": "none"})

    assert duplicate[0] == 409 and system[0] == 409 and system_id[0] == 409
    assert system_id[1]["error"]["message"] == (
        "esp-upload: a serial settings config has this name or id")
    assert [item["name"] for item in json.loads(path.read_text(encoding="utf-8"))["configs"]] == [
        "My board"]

    applied = await cli_run("settings", "apply", SERIAL_NAME, "esp-upload")

    assert applied == Outcome(0, (f"{SERIAL_NAME}: config ESP upload, settings 115200 8N1, "
                                  "on open: esp-bootloader\n").encode(), "")
    await tab.until(lambda: record(tab)["config"] == "esp-upload")


async def test_acc_prof_209_a_system_config_is_copied_never_changed(api, fake_tab):
    """ACC-PROF-209 applying a system config, changing a field and saving the values makes a user config; the system config is unchanged."""
    await attach_serial(fake_tab)
    before = (await api("GET", "settings-configs"))[1]["configs"]
    await api("PUT", "serial", SERIAL_NAME, "settings", body={"config": "monitor"})
    await api("PUT", "serial", SERIAL_NAME, "settings", body={"baudRate": 57600})

    status, saved = await api("POST", "settings-configs", body={
        "name": "Fast monitor", "baudRate": 57600, "dataBits": 8, "parity": "none",
        "stopBits": 1, "onOpen": "none"})
    after = (await api("GET", "settings-configs"))[1]["configs"]

    assert (status, saved["name"], saved["system"]) == (200, "Fast monitor", False)
    assert after[:6] == before[:6]
    assert [item["name"] for item in after[6:]] == ["Fast monitor"]


async def test_acc_prof_206_delete_a_saved_config_keeps_the_port_values(api, fake_tab, settings_file):
    """ACC-PROF-206 deleting a config a port uses removes it and leaves the port custom with its values; a system config is refused."""
    await attach_serial(fake_tab)
    _, saved = await api("POST", "settings-configs", body={
        "name": "Mine", "baudRate": 57600, "dataBits": 8, "parity": "even",
        "stopBits": 2, "onOpen": "pulse-rts"})
    await api("PUT", "serial", SERIAL_NAME, "settings", body={"config": saved["id"]})

    status, _ = await api("DELETE", "settings-configs", saved["id"])
    record = (await api("GET", "devices"))[1]["serial"][0]

    assert status == 200
    assert (record["config"], record["configName"]) == (None, None)
    assert record["configured"]["baudRate"] == 57600
    assert json.loads(pathlib.Path(settings_file).read_text(encoding="utf-8"))["configs"] == []

    refused = await api("DELETE", "settings-configs", "Monitor")
    assert refused[0] == 409
