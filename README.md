# jupyterlab_device_bridge_extension

[![GitHub Actions](https://github.com/stellarshenson/jupyterlab_device_bridge_extension/actions/workflows/build.yml/badge.svg)](https://github.com/stellarshenson/jupyterlab_device_bridge_extension/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/jupyterlab_device_bridge_extension.svg)](https://www.npmjs.com/package/jupyterlab_device_bridge_extension)
[![PyPI version](https://img.shields.io/pypi/v/jupyterlab-device-bridge-extension.svg)](https://pypi.org/project/jupyterlab-device-bridge-extension/)
[![Total PyPI downloads](https://static.pepy.tech/badge/jupyterlab-device-bridge-extension)](https://pepy.tech/project/jupyterlab-device-bridge-extension)
[![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4-orange.svg)](https://jupyterlab.readthedocs.io/en/stable/)
[![Brought To You By KOLOMOLO](https://img.shields.io/badge/Brought%20To%20You%20By-KOLOMOLO-00ffff?style=flat)](https://kolomolo.com)
[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat)](https://www.paypal.com/donate/?hosted_button_id=B4KPBJDLLXTSA)

Bridge serial (COM) ports and USB devices of the browser's computer into the JupyterLab container, so terminal programs and AI agents can program and read microcontroller boards.

The container has no access to the hardware. The browser has it, after the user grants one device in Chrome's dialog. The extension carries that device from the browser tab to the programs in the container.

```
board → Windows driver → Chrome tab (Web Serial, WebUSB) → WebSocket → Jupyter server extension → endpoint in the container → terminal programs
```

> [!IMPORTANT]
> This repository holds the project scaffold. The features below are the scope of the first version and are not implemented yet. Nothing has been tested with a physical board.

## Features

- **Serial ports in the container** - a port granted in the browser appears as a virtual serial device at a stable path, so an upload tool or a monitor opens it as a serial device
- **USB devices in the container** - a granted USB device answers control, bulk and interrupt transfers from container programs through a Python client and a pyusb backend
- **Port profiles** - parity, data bits, stop bits and the action on open, with built-in profiles for Arduino, STM32 and ESP boards
- **Monitor for agents** - the server keeps the most recent bytes received from each port, so a short command-line call reads output that arrived before the call
- **Panel and status bar item** - the panel lists attached devices, the program that holds each one and the pending device requests; a status bar item is visible while any device is attached
- **Command line** - one CLI to list devices, set profiles, read and write a port, run a tool with the preload shim and ask the user for a device
- **Opened only on the user's grant** - a device is opened only after the user's click in the browser's dialog, and every server endpoint sits behind Jupyter's authentication

## Requirements

- JupyterLab >= 4.6
- A browser with the Web Serial and WebUSB interfaces
- The lab opened over HTTPS or at `localhost`; on a plain `http://` address that is not localhost the browser does not offer these interfaces

## Install

To install the extension, execute:

```bash
pip install jupyterlab_device_bridge_extension
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlab_device_bridge_extension
```
