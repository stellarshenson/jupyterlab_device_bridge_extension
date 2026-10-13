# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [0.6.27] - 2026-10-13

The Devices panel now controls the programs that use a device: it lists them, starts a device shell and stops a program. One plus icon replaces the two add buttons. The extension is tested against simulated devices in the browser; no test used a physical board. One known defect: a launch that the server of the terminal extension 1.0.7 refuses shows `[object Object]` as its reason.

### Added

- Run control: the Devices panel lists every program started through `jupyterlab-device run` or `jupyterlab-device shell`, in any terminal, with the buttons **Start**, **Info** and a two-step **Stop**
- Device shell: `jupyterlab-device shell` starts the shell of the lab's terminals with the preload shim and prints a banner that names the installed upload tools and lists the attached devices
- TX and RX lamps on every device row, which follow the rate of the traffic
- One plus icon in the header of the panel, with the menu entries Connect Serial Port and Connect USB Device
- `jupyterlab-device help` and `jupyterlab-device help <command>`, which print what `--help` prints, and `jupyterlab-device --version`
- The banner of the device shell has no colour when the variable `NO_COLOR` is set
- `jupyterlab-device --help` ends with one example command line for each upload tool found on `PATH`
- A notification with the reason when the terminal extension refuses a launch

### Changed

- The serial terminal and the device shell open through `jupyterlab_basic_terminal_extension` 1.0.7 or newer, which pip installs together with this extension: the terminal runs one program, no command line is typed into it, and its tab closes when the program ends
- The plus icon replaces the buttons **Add serial port** and **Add USB device**, and the section of the devices is titled Serial and USB devices
- **Stop** sends `SIGHUP`, and `SIGKILL` 3 s later, in place of `SIGTERM`. A tool that `run` started then ends with status 129

### Fixed

- Start failed in a lab whose terminals run fish through a launcher, because it relied on the variable `SHELL`. The shell command now comes from the terminal manager of the server
- Stop left the tool of a fish shell running, and a bash shell stayed listed for 3 s
- The settings text of `showMenu` named four of the five commands of the Devices menu

## [0.6.20] - 2026-10-12

The repository and the wheel now hold three proposed installers of the firmware tools, and the agent skill names them. No test of this extension ran an installer.

### Added

- Installers of the firmware tools in `resources/envs/`: `firmware-avr.py`, `firmware-stm32.py` and `firmware-esp.py`, each for one conda environment with the tools that build firmware and upload it, and `firmware_env.py`, the module they import. The README describes them in the subsection `Installers of the firmware tools`
- The wheel installs the four files in `envs/` beside the agent skill, at `<sys.prefix>/share/jupyter/agents/skills/jupyterlab-device-bridge-extension/envs/`

### Changed

- Agent skill: one new rule names the installers and both folders, and tells the agent to ask the user before it runs one. The description of the skill names the installation of the tools

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
