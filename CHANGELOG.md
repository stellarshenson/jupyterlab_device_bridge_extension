# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.0.65] - 2026-10-20

The banner of the device shell is shorter when an agent already finds the agent skill. The extension is tested against simulated devices in the browser; no test used a physical board.

### Changed

- Banner of `jupyterlab-device shell`: when an agent finds the skill, linked in `~/.agents/skills` or `~/.claude/skills` or listed by a skill there such as GalaxaLab's, the Agent skill section shows only the path of its `SKILL.md`; the line with the skill name and `✓ linked in` or `✓ listed by` is gone. When no agent finds the skill, or the wheel did not install it, the section still says so

## [1.0.62] - 2026-10-20

The serial terminal is a plain serial terminal with select, copy and paste, the agent skill documents any device in one reference format, and a starting device bridge removes the stale devices of its folder. The extension is tested against simulated devices in the browser; no test used a physical board.

### Added

- Device references in the agent skill: `references/device-reference.md` gives one format for any device, with sections for the device protocol and code and the host protocol and code, and the procedure an agent follows to research a device, download its datasheets and save the reference under `references/devices/` of a project made from the copier embedded project template
- Worked example `references/devices/turmo-usb-monitor.md`: the TURMO 3.5 inch USB screen, its protocol, its traps and recovery, and the host programs `turmo.py`, `gpu_status.py` and `dashboard.html`
- Stale device sweep: when the server starts and each time a lab tab connects, the device folder loses every `tty-*` or `usb-*` link, link to a pty and shim socket that belongs to no device of the bridge; the entries of the devices the panel lists stay
- Serial terminal: the mouse wheel, Up and Down scroll the traffic view one line, PgUp and PgDn one page
- The serial terminal tab is named Serial Terminal and carries the device icon

### Changed

- The serial terminal leaves the mouse to the lab terminal: a selection copies with Ctrl+C, Ctrl+V pastes the first line of the clipboard into the send field, and Ctrl+C with no selection still sends `0x03`. The board keys F2 to F10 are gone; the CLI keeps the line, break and run commands
- Ctrl+P holds the traffic view; lines that arrive while it is paused are kept and shown at the next Ctrl+P
- Settings dialog: the baud rate is an editable field joined to a button that lists the sixteen standard rates; **Save** is the only filled button, **Delete config** sits at the far left in the error colour, and rows are separated by hairlines
- The firmware environment installers are no longer in this repository or the wheel; they are in the template of the copier embedded project, and the skill, the README and a missing-tool probe name it there
- The next step of a probe whose tool is missing re-runs the probe after the installer

### Fixed

- The settings dialog controls had ragged widths because JupyterLab wraps each select in a shrink-wrapping wrapper (DEF-PANEL-27)
- A paused traffic view moved one line for each arriving line once it held 5000 lines (DEF-TERM-29)

## [1.0.35] - 2026-10-18

The Devices panel gets a settings dialog that reads as a table, a help tab on the lab's own Markdown viewer, byte counters that change unit, and a server discovery that identifies the lab hosting the command. The extension is tested against simulated devices in the browser; no test used a physical board.

### Added

- Help tab: the help button of the Serial and USB header writes the file `Device Bridge Help` at the root of the contents and opens it in the lab's read-only Markdown Preview; the document covers the panel options, the connections, the tools and the connection configs. A second click activates the same tab
- Settings dialog as a table: one row per setting, alternating shaded rows, one control per value cell; baud rate is one editable field that lists the standard rates 300 to 921600 and shows a Custom badge when the value is not standard; the buttons are slim, 28 px high
- Run rows: Copy shows Copied for 1.5 s, a run that ends within 3 s stays visible until 3 s, and a lingering stopped row disables Stop
- Server discovery: the client prefers the listed server whose pid is an ancestor of its process; a failed `jupyter server list --json` is retried three times and then refused with its reason instead of falling back to a port where nothing listens
- Saved configs: a name or id equal to an existing config's name or id is refused

### Changed

- The RX and TX counters show a unit: byte or bytes below 10 KB, KB with one decimal from 10 KB, MB with one decimal from 1 MB, so 999999 reads 1.0 MB
- The panel footer has no separator above the round trip, and the round trip text uses the same muted colour as its label
- The baud rate of a serial port is one field in the settings table; the separate Custom select and text field are gone
- The installer copies come from the copier embedded project's template: `make build` syncs them, the wheel ships three installers and `firmware_env.py`, and `firmware-stm32.py` absorbs the PlatformIO installer
- The agent skill names the installers and the environment installer route; the README and the design document the new settings table and counters

### Fixed

- A failed `jupyter server list --json` was read as an empty list, and the client then reported a connection refused at `JUPYTER_PORT` instead of the real cause
- A saved config name equal to a system config id could shadow the system config; the save now refuses it

## [1.0.5] - 2026-10-17

The device shell opens with a larger banner, and the help texts of the command line, the serial terminal and the environment selector say more. The extension is tested against simulated devices in the browser; no test used a physical board.

### Added

- Banner of `jupyterlab-device shell`: DEVICE BRIDGE in block letters, at 75% of the terminal's width, on one row from 91 columns and on two rows below that. Sections Environment, Devices, Agent skill and Commands follow it. Device names and their information have colours of their own, in the dark or light theme of the terminal; with `NO_COLOR` set, the banner has no colour
- The Agent skill section of the banner says where the wheel installed the skill and whether `~/.agents/skills` or `~/.claude/skills` links or lists it
- `jupyterlab-device --help` has a quick start from an attached board to its output, and a section on the agent skill with the two commands that link it
- Ctrl+Y in the serial terminal opens a list of every key with what it does; Esc or Ctrl+Y closes it
- The environment selector of the device shell says what the choice changes

### Changed

- The installer `firmware-avr.py` in `resources/envs/` also installs simavr and pytest, as its original does

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
