---
name: jupyterlab-device-bridge-extension
description: Reach a serial port (COM port) or a USB device plugged into the user's computer from a JupyterLab container, through the `jupyterlab-device` CLI of jupyterlab_device_bridge_extension. Use when uploading firmware to a board (Arduino, STM32, ESP), installing the tools that build or upload it, reading or writing a board's serial output, running a pyusb program against a USB probe, or "flash the board".
---

# jupyterlab-device

Runs in a lab terminal. Device sits on the user's computer, lab tab in Chrome or Edge holds it, Jupyter server hands it to container programs. Commands, flags, output, exit codes: `jupyterlab-device --help`, `jupyterlab-device <command> --help`. Read first.

## Rules

- No program grants a device. User picks it in Chrome's dialog. `list` empty: ask user to add it in the Devices panel (if no sidebar has the panel: menu View, item Show Devices Panel), or run `request` and tell user to press Grant. `request` blocks until then
- Serial tool opens the path `list` prints, never `/dev/ttyUSB0` or `COM3`. Container has no such node
- State `detached` in `list`: path still opens, bytes reach no board. `error:` at the end of an `attached` line: port failed in the browser, which does not retry by itself. Tell user the reason; cause gone: set the board's profile again with `profile`, then `list` again. Upload only when `attached` and no `error:`
- One program holds a serial device at a time, `list` names it. `monitor read` and `monitor write` do not open the device, so both work while a tool holds it
- `terminal` is interactive, needs a person at a terminal. Agent reads with `monitor read` and writes with `monitor write`, never with `terminal`
- `monitor read --follow` runs for the whole `--timeout`. Long buffer: pass `--lines`
- Before an upload set the board's profile with `profile`. Device is a pty: holds baud rate only. Parity and reset on open come from the profile. `on open <action>` in a `list` line: port has an action of its own in place of the profile's; `profile` with an id removes it
- Tool sets DTR, RTS or parity itself (esptool, stm32flash, pyserial with parity): start it under `run --`. Without it the device refuses or drops those calls. Static binary does not load the shim: profile only
- PlatformIO: pio does not find the virtual device by itself. Upload with `run -- pio run -t upload --upload-port <path>`, monitor with `pio device monitor --port <path>`, or set `upload_port` and `monitor_port` in `platformio.ini` to the path
- Tool started under `run --` is a run: Devices panel of the lab (if no sidebar has the panel: menu View, item Show Devices Panel) lists it, user can stop it there. Tool then gets SIGHUP, SIGKILL 3 s later when it still runs
- `shell` is a device shell for a person at a terminal: the shell of the lab's terminals with the shim, runs until `exit`. Agent starts each tool under `run --`
- Action `touch-1200` may bring the board back as another USB device. Needs a new grant from user
- `usb open` and `usb claim` last until `usb close`. pyusb program: module `jupyterlab_device_bridge_extension.pyusb_backend`, `get_backend()` or `install()`
- Build or upload tool missing (cargo, avr-gcc, avrdude, stm32flash, espflash, esptool, pio): installers `firmware-avr.py`, `firmware-stm32.py`, `firmware-esp.py` in `envs/` beside this file, in a clone `resources/envs/` of the repository. Each is a `uv` script, run it as a program: makes one conda environment, named as the file without `.py`, and downloads its toolchain. Needs `uv`, x86-64 Linux, internet, conda at `/opt/conda/bin/conda` or in `CONDA_CMD`. Ask user before running one. This extension's tests never ran one
