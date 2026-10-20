# Brief - jupyterlab_device_bridge_extension

A copy of this brief is saved in the project as `docs/brief.md`.

## Purpose

The extension gives programs in the lab container access to a serial port (COM port) or a USB device that is plugged into the computer where the browser runs. The first user of it is an AI agent in the lab terminal: it builds firmware in the container (Rust for Arduino Uno, Nano and Mega, ATtiny, STM32, ESP32 and ESP8266), uploads it to the board, then reads the board's serial output.

```
board → Windows driver → Chrome tab (Web Serial, WebUSB) → WebSocket → Jupyter server extension → endpoint in the container → the agent's tools
```

The container has no access to the hardware. The browser has it, after the user grants one device in Chrome's dialog.

## Read first

Two extensions in this folder already bridge a browser capability to terminal programs. This extension repeats their three parts (frontend plugin, server extension, CLI). Read their README, `docs/`, the Python package and `src/` before you design:

- `../jupyterlab_voice_capture_extension` - browser microphone → server-side FIFO (`routes.py`, `sink.py`, `cli.py`)
- `../jupyterlab_passkey_extension` - a local program asks, the browser tab acts, the result returns to the program (`relay.py`, `routes.py`, `cli.py`, README section "Working with an AI agent")

## Facts tested in this container

| Fact | Test | Date |
|---|---|---|
| A virtual serial device (pty) carries data bytes in both directions | pty pair, Python | 2026-10-05 |
| The bridge side of a pty sees the baud rate that the tool sets | `tcgetattr` on the master | 2026-10-12 |
| The bridge side of a pty sees a tool opening and closing the device | `POLLHUP` on the master | 2026-10-05 |
| A pty refuses the DTR and RTS calls (`TIOCMBIS`, `TIOCMBIC`, `TIOCMSET`): `ENOTTY` | Python `fcntl.ioctl` | 2026-10-12 |
| A pty drops the parity setting: the tool sets 8E1 and reads back 8N1 | Python `termios` | 2026-10-12 |
| A preloaded library (`LD_PRELOAD`) that replaces `ioctl`, `tcsetattr` and `tcgetattr` for one device accepts the DTR and RTS calls, keeps the parity setting, and passes both to the bridge over a Unix socket | 80-line C library, gcc, Python as the tool | 2026-10-12 |
| Chrome 155 has `navigator.serial`, `navigator.usb` and `navigator.hid` in a page and in a dedicated Web Worker on `http://localhost` | headless Chrome | 2026-10-12 |
| On a plain `http://` address that is not localhost, all three are absent in page and worker | headless Chrome, `http://172.24.0.5` | 2026-10-12 |
| The container has no `/dev/bus/usb`; the kernel module for USB/IP (`vhci-hcd`) is not loaded and `/lib/modules` is absent | `ls`, `/proc/config.gz` | 2026-10-12 |
| `avrdude`, `stm32flash`, `esptool`, `pyserial`, `pyusb`, `pyocd` are not installed | `conda env list`, imports | 2026-10-12 |

The shim test used Python's standard library as the tool. No test used a real upload tool or a physical board.

## Statements from knowledge, not tested

Verify each one that your design depends on.

- Web Serial and WebUSB exist in desktop Chrome and Edge only; Firefox and Safari have neither
- Chrome opens its port dialog and its USB device dialog only inside a user gesture (a click); a program cannot grant a device. Devices granted earlier are returned by `navigator.serial.getPorts()` and `navigator.usb.getDevices()` without a gesture
- Web Serial sets the baud rate, parity, data bits and stop bits only in `port.open()`; a change needs close and reopen. `port.setSignals()` sets DTR and RTS
- On Windows, opening a COM port can assert DTR, which resets an Arduino Uno
- WebUSB cannot claim an interface that Windows has bound to another driver. A COM-port device belongs to the serial driver, so serial devices go through Web Serial. Chrome also blocks the classes audio, HID, mass storage, smart card, video and wireless controller
- On Windows, WebUSB needs the WinUSB driver on the interface. CMSIS-DAP v2 probes declare it themselves. ST-Link needs ST's driver package. USBasp and the STM32 DFU bootloader need Zadig or STM32CubeProgrammer
- A board that changes into bootloader mode can appear as a different device (Arduino Leonardo and Micro, STM32 DFU, Digispark) and needs its own grant
- `avrdude -c arduino` prints a warning when its DTR call is refused and continues; `esptool` stops unless reset is switched off (`--before no-reset`); `stm32flash` reads its serial settings back after setting them and the STM32 serial bootloader needs even parity
- pyOCD reaches ST-Link and CMSIS-DAP v2 probes through pyusb with the backend from `libusb_package`
- probe-rs reads the Linux USB file system directly, not through libusb

## Required behaviour - serial ports

- The user adds a port with a button in the panel. A granted port is attached again on page load without a click
- Each attached port has one virtual serial device in the container at a stable path that a tool accepts as a serial device. The container process is unprivileged, so the path is outside `/dev`
- Data bytes pass in both directions, binary-safe, in order, without loss
- The baud rate that the tool sets on the virtual device is applied to the physical port
- The bridge detects a tool opening and closing the virtual device
- **Port profile:** parity, data bits, stop bits and the action on open (none, pulse DTR, pulse RTS, ESP bootloader entry, 1200-baud touch), set from the panel and from the CLI. Built-in profiles: Arduino Uno/Nano/Mega upload, Arduino as ISP programmer (no reset on open), STM32 serial bootloader (8E1), ESP upload, plain monitor. The extension must be usable with profiles alone
- **Preload shim:** a small library that passes a tool's own DTR and RTS calls and its parity setting to the bridge, plus a CLI form that starts a tool with it (`... run -- avrdude ...`). A statically linked tool does not load it, which is why profiles must suffice. How the library is packaged is your decision; state it in the README
- **Monitor for the agent:** the server keeps the most recent bytes received from each port, so a short-lived CLI call can read output that arrived before the call. The CLI reads (last N lines, follow with a time limit) and writes
- The code that moves bytes between the port and the WebSocket runs in a dedicated Web Worker. The panel shows the measured round trip between browser and server

## Required behaviour - USB devices

- The user adds a device with a button in the panel. A granted device is attached again on page load without a click
- A program in the container can ask for a device that is not granted yet (vendor id, product id, reason). The panel shows the request, and the user's click opens Chrome's dialog with that filter
- Operations offered to container programs: list devices with descriptors (configurations, interfaces, endpoints, strings), open, close, select configuration, claim and release interface, select alternate setting, control transfer in and out, bulk and interrupt transfer in and out, clear halt, reset
- A Python client module with those operations, and a pyusb backend on top of it, so a pyusb program can use a bridged device. Document how a program is pointed at that backend; pyOCD is the case to describe
- A Chrome error (interface held by a system driver, blocked class, device removed, stall) reaches the calling program with Chrome's reason text
- The README carries a table: device kind → Windows driver needed

## Panel

- Lists every attached device: kind, name, state, the program that holds it, baud rate and profile for a serial port, byte counters
- Buttons to add a serial port, add a USB device, detach, and forget a grant
- Pending device requests from container programs
- A status bar item is visible while any device is attached, so the user always sees that programs in the container have access to hardware

## CLI, Python client, documentation for agents

- One CLI (suggested name `jupyterlab-device`) with subcommands for list, status, profiles, monitor read and write, run-with-shim, device request, USB describe and raw transfers. Every subcommand has `--help`; list and status have a machine-readable output
- README section "Working with an AI agent" with the upload and monitor commands for each board family

## Constraints

- Works in an unprivileged container: no sudo, no kernel module, no device node. This workstation's container has sudo and `/dev/cuse`; a hub lab does not
- The lab must be reached over HTTPS or `localhost`; say so in the README and show a clear message in the panel when the browser interfaces are absent
- A device is opened only after the user's grant; server endpoints sit behind Jupyter's authentication; the CLI authenticates the way the two reference extensions do
- One browser tab owns a device. A second lab tab shows it as held by the other tab

## Tests without hardware

You have no board, and headless Chrome has no ports. Simulate devices at the browser interface (`navigator.serial`, `navigator.usb`) in Jest and in the Galata tests, and run the whole path against them: a serial device that echoes and records its open parameters and control lines, and a USB device that answers control and bulk transfers. Where an upload tool is installed, a simulated bootloader that lets the real tool complete an upload is the strongest check.

The firmware environment installers are `firmware-avr.py`, `firmware-stm32.py` and `firmware-esp.py` in the copier embedded project template at https://github.com/stellarshenson/copier-embedded-project, under `template/resources/envs` (conda environments of 2 to 5 GB, none installed now); this extension ships none. Install one only if a test needs its tool. Do not install with apt.

Every criterion that needs a physical board gets the test tag `MANUAL` and stays open for the user. Do not state that anything works with hardware.

## Not in the first version

Record these in the README as limits:

- A replacement libusb library for C tools (avrdude with USBasp, dfu-util, OpenOCD, st-flash)
- WebHID devices (CMSIS-DAP v1 probes, HID bootloaders)
- Kernel routes for a privileged container (USB/IP, CUSE)
- Upload protocols that run inside the browser
- Isochronous transfers
- probe-rs
