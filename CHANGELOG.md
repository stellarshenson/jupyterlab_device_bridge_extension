# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [0.6.18] - 2026-10-12

First release. Bridges serial ports and USB devices of the browser's computer into the JupyterLab container. The extension is tested against simulated devices in the browser; no test used a physical board.

### Added

- Serial ports in the container: a port granted in the browser has a virtual serial device at a stable path, and the baud rate a tool sets on that device is the baud rate the browser opens the port with
- Port profiles with parity, data bits, stop bits and the action on open, with built-in profiles for Arduino, STM32 and ESP boards
- Preload shim: a tool started with `jupyterlab-device run` has its DTR, RTS, break and parity calls passed to the port
- Monitor buffer: the server keeps the most recent bytes received from each port, so a command-line call reads output that arrived before the call
- Serial terminal: pyserial's miniterm in a JupyterLab terminal, on the virtual device
- USB devices in the container: a granted USB device answers control, bulk and interrupt transfers through the command line, a Python client and a pyusb backend
- Device requests: a container program asks for a device, and the lab shows the request with a Grant button
- Devices panel and status bar item. The panel is hidden by default; the View menu item `Show Devices Panel` and the setting `showPanel` are one option
- Default serial settings of a new port on the settings page: baud rate, data bits, parity, stop bits and the action on open
- Command line `jupyterlab-device`, with a `--help` on every command that is written for an AI agent, and an agent skill that the wheel installs
- A device is opened only after the user chose it in the browser's dialog, and every server endpoint is behind Jupyter's authentication

<!-- <END NEW CHANGELOG ENTRY> -->
