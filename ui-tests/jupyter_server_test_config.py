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
c.ServerApp.port = int(os.environ.get("JUPYTER_TEST_PORT") or "8888")

# The GalaxaHub message-of-the-day extension, where installed, opens its own tab at lab
# start. Galata waits for the Launcher tab to be active, so every test would time out in
# page.goto(). Ignored where the extension is not installed.
c.GalaxaHubMotd.open_on_start = False

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
