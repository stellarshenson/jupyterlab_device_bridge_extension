import asyncio
import json
import os
import shutil
import sys
import tempfile

import pytest
import tornado.httpclient

from jupyterlab_device_bridge_extension.routes import MANAGER_KEY, NAMESPACE
from jupyterlab_device_bridge_extension.tests.fake_tab import FakeTab

pytest_plugins = ("pytest_jupyter.jupyter_server", )


@pytest.fixture
def device_dir():
    """The device directory of one test server, which makes it at the first serial claim.

    It is short on purpose: the path of a Unix socket holds about 100 characters,
    and pytest's own temporary paths are longer than that with the shim socket's name.
    """
    parent = tempfile.mkdtemp(prefix="jdb-")
    yield os.path.join(parent, "devices")
    shutil.rmtree(parent)


@pytest.fixture
def jp_server_config(jp_server_config, device_dir):
    return {
        "ServerApp": {
            "jpserver_extensions": {"jupyterlab_device_bridge_extension": True},
            # Test against a server which requires authentication on all endpoints
            "allow_unauthenticated_access": False,
        },
        "DeviceBridge": {"device_dir": device_dir},
    }


@pytest.fixture
def jp_serverapp(jp_serverapp):
    """The test server; its virtual serial devices and shim sockets are removed after the test."""
    yield jp_serverapp
    jp_serverapp.web_app.settings[MANAGER_KEY].close()


@pytest.fixture
def manager(jp_serverapp):
    """The `DeviceManager` of the test server."""
    return jp_serverapp.web_app.settings[MANAGER_KEY]


@pytest.fixture
def bridge_address(jp_serverapp, http_server, jp_http_port, jp_base_url):
    """Where a client reaches the test server: `(url, token)`.

    `DeviceBridgeClient(*bridge_address)` is a client of the test server. The address is
    127.0.0.1 and not localhost: the test server listens on IPv4 only, and localhost is
    tried on ::1 first, where another program can listen on the same port number.
    """
    url = f"http://127.0.0.1:{jp_http_port}{jp_base_url}".rstrip("/")
    return url, jp_serverapp.identity_provider.token


@pytest.fixture
def fake_tab(bridge_address, jp_asyncio_loop):
    """Factory of browser tab doubles, see `tests/fake_tab.py`.

    `tab = await fake_tab()` connects a tab with the id `tab-1` to the test server;
    `await fake_tab("tab-2")` connects a second one. Every tab is closed after the test.
    """
    url, token = bridge_address
    tabs = []

    async def connect(tab_id="tab-1"):
        tabs.append(await FakeTab.connect(
            f"ws{url.removeprefix('http')}/{NAMESPACE}/ws", {"Authorization": f"token {token}"}, tab_id))
        return tabs[-1]

    yield connect
    for tab in tabs:
        jp_asyncio_loop.run_until_complete(tab.close())


@pytest.fixture
def api(jp_fetch):
    """Call the REST API of the bridge on the test server.

    `status, document = await api("POST", "usb", name, "open", body={...})`; keyword
    arguments other than `body` are query parameters: `await api("GET", "serial",
    name, "monitor", since=0, wait=1)`. A refusal is returned, not raised. A GET and a
    DELETE carry no body, and the document of an answer without a body is None.
    """
    async def call(method, *path, body=None, **query):
        try:
            response = await jp_fetch(
                NAMESPACE, *path, method=method, params=query,
                body=None if method in ("GET", "DELETE") else json.dumps({} if body is None else body))
        except tornado.httpclient.HTTPClientError as error:
            response = error.response
        return response.code, json.loads(response.body) if response.body else None

    return call


@pytest.fixture
def tool(jp_asyncio_loop):
    """Factory of serial tools: child processes that use a virtual serial device.

    `process = await tool(SCRIPT, path, ...)` starts `python -c SCRIPT path ...` with
    pipes on its stdin and stdout. A tool has to be a child process: a blocking call on
    the device from the test itself stops the event loop that serves the device. Every
    child that still runs is killed after the test.
    """
    children = []

    async def start(script, *args):
        children.append(await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, *map(str, args),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE))
        return children[-1]

    yield start
    for child in children:
        if child.returncode is None:
            child.kill()
            jp_asyncio_loop.run_until_complete(child.wait())
