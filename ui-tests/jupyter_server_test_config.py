"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import os
from tempfile import mkdtemp

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# configure_jupyter_server moves the workspaces and the server root, not the user settings;
# without this a settings write to the test server lands in ~/.jupyter/lab/user-settings
c.LabApp.user_settings_dir = mkdtemp(prefix="galata-settings-")

# `or`, not a get() default: JavaScript's `||` reads "" as absent and falls back, so an
# exported-but-empty JUPYTER_TEST_PORT must fall back here too (playwright.config.js)
port = int(os.environ.get("JUPYTER_TEST_PORT") or "8888")
c.ServerApp.port = port

# The virtual serial devices and the shim sockets of the test server get their own
# directory, so the suite never shares one with a lab of this machine. It is under /tmp
# like the default, because the path of a Unix socket holds about 100 characters.
# sweep-scratch.js removes the same path.
c.DeviceBridge.device_dir = f"/tmp/jupyterlab-device-galata-{port}"

# The shell command of the lab's terminals is pinned. A device shell is that command with
# the preload shim, and the suite must run the same shell on every machine: a machine
# can set a start script of its own for its terminals. The specs read it with GET status.
c.ServerApp.terminado_settings = {"shell_command": ["/bin/bash"]}

# The server of a real lab can run without the variable SHELL, and its terminals then
# have none (DEF-PANEL-15). The shell that starts the suite has the variable, so it is
# removed from the environment of the test server and with it from every terminal.
os.environ.pop("SHELL", None)

# The GalaxaHub message-of-the-day extension, where installed, opens its own tab at lab
# start. Galata waits for the Launcher tab to be active, so every test would time out in
# page.goto(). Ignored where the extension is not installed.
c.GalaxaHubMotd.open_on_start = False

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
