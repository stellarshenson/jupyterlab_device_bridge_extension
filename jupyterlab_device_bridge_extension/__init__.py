try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_device_bridge_extension' outside a proper installation.")
    __version__ = "dev"
import atexit
import os

from traitlets import Integer, Unicode, default
from traitlets.config import Configurable

from .manager import DeviceManager
from .routes import MANAGER_KEY, setup_route_handlers


class DeviceBridge(Configurable):
    """Configuration of the device bridge server extension."""

    device_dir = Unicode(
        config=True,
        help="Directory of the virtual serial devices and the shim sockets. It is made with "
             "mode 0700 and must be a real directory of the server's user. The default is "
             "the environment variable JUPYTERLAB_DEVICE_DIR, else /tmp/jupyterlab-device-<uid>.",
    )
    monitor_bytes = Integer(
        262144,
        config=True,
        help="Most bytes of serial output the server keeps for each port.",
    )

    @default("device_dir")
    def _default_device_dir(self):
        # /tmp and not the home directory: a home on a network volume cannot hold a Unix socket.
        return os.environ.get("JUPYTERLAB_DEVICE_DIR") or f"/tmp/jupyterlab-device-{os.getuid()}"


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "jupyterlab_device_bridge_extension"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyterlab_device_bridge_extension"
    }]


def _load_jupyter_server_extension(server_app):
    """Creates the device manager and registers the WebSocket and REST handlers.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    config = DeviceBridge(config=server_app.config)
    manager = DeviceManager(config.device_dir, config.monitor_bytes, server_app.log)
    server_app.web_app.settings[MANAGER_KEY] = manager
    # A server extension of this form has no stop hook: the ptys, the symlinks and the
    # shim sockets are released when the server process ends.
    atexit.register(manager.close)
    setup_route_handlers(server_app.web_app)
    name = "jupyterlab_device_bridge_extension"
    server_app.log.info(f"Registered {name} server extension (device_dir={config.device_dir})")
