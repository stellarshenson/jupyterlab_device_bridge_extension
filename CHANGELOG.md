# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.0.3] - 2026-10-16

The version number moves from 0.6.30 to 1.0.3. The code, the settings and the dependencies are those of 0.6.30. The extension is tested against simulated devices in the browser; no test used a physical board.

### Changed

- Version 1.0.3 in place of 0.6.30, with no other change

## [0.6.30] - 2026-10-16

The serial terminal is now a full-screen app of this extension, a device shell can start in the environment that holds an upload tool, and PlatformIO joins the upload tools. The extension is tested against simulated devices in the browser; no test used a physical board.

### Added

- Serial terminal app: `jupyterlab-device terminal` shows each received line and each sent block with its time, as text or as hex digits, sends a typed line with a chosen line ending, sets DTR and RTS, sends a break and runs the actions of the board on function keys. Ctrl+O opens its settings for baud rate, data bits, parity, stop bits, line ending and text or hex. It has a dark and a light theme, chosen from the background of the terminal
- Environment of the device shell: when a conda environment, or the `.venv` of the start folder, holds an upload tool, `jupyterlab-device shell` first lists those environments with their tools and starts the shell in the chosen one
- pio (PlatformIO) is one of the upload tools that the banner of the device shell, the Info dialog and `jupyterlab-device --help` name. The README section `PlatformIO` gives the upload and monitor command lines
- Settings dialog on each serial port of the Devices panel, with the profile, baud rate, data bits, parity, stop bits and the action on open

### Changed

- The serial terminal replaces pyserial's miniterm. Ctrl+Q or Esc quits it
- The wheel requires `jupyterlab_basic_terminal_extension` 1.0.9 or newer and `textual` 8.2 or newer
- A lit TX lamp has the brand colour of the theme and a lit RX lamp is yellow
- The panel uses short section titles and button texts, with the full text in the tooltip
- The installers `firmware-avr.py` and `firmware-esp.py` in `resources/envs/` install PlatformIO with the Arduino core; `firmware-esp.py` no longer installs arduino-cli

### Fixed

- Closing the tab of the serial terminal or of a device shell left the program running and the port held. Closing the tab now ends the program
- `jupyterlab-device terminal` started without a terminal, for example by an agent, waited for keys forever and held the port. It now exits with status 2 and names `monitor read` and `monitor write`
- The label of an armed **Confirm stop** or **Confirm forget** button was not opaque in the dark theme

## [0.6.29] - 2026-10-13

### Changed

- The wheel requires `jupyterlab_basic_terminal_extension` 1.0.8 or newer

### Fixed

- A launch that the server of the terminal extension refuses now shows that server's code as the reason, for example `The terminal did not start: invalid_cwd` when the folder of the file browser no longer exists. It showed `[object Object]`

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
