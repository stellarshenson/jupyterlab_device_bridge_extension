# Scenarios

Step-by-step recipes for the common jobs. Per-board upload behaviour: `boards.md` beside this file. Flags and output of every command: `jupyterlab-device --help`, `jupyterlab-device <command> --help`.

## A board appears for the first time

1. `jupyterlab-device list` - empty means the lab tab holds no port
2. Ask the user to grant it: Devices panel (menu View, item Show Devices Panel, button Grant), or run `jupyterlab-device request`, which blocks until the user presses Grant
3. `jupyterlab-device list` - one line per port, state `attached`, the path to hand to every tool

## Upload firmware

1. `jupyterlab-device settings apply <device> "<config>"` - `settings list` shows the configs: Arduino upload, STM32 bootloader, ESP upload, and the user's own
2. `jupyterlab-device list` - the line must say `attached` and carry no `error:`
3. `jupyterlab-device run --device <name> -- <uploader ...> <path>` - the per-board uploader form is in `boards.md`
4. `jupyterlab-device monitor read <device> --lines 20` - the board's boot line proves the new firmware runs

## Watch the output while a tool holds the port

- `jupyterlab-device monitor read <device> --follow --timeout 15`, `--lines 0` to start at new output only
- The monitor does not open the port, so it works beside an uploader

## A port failed in the browser

- `list` shows the port `attached` with `error:` and the browser's reason, often `removed` after a reset or a re-enumeration
- Ask the user to do what the reason names (reconnect the board, reset it)
- `jupyterlab-device settings apply <device> "<config>"` applies the settings again, which retries the port, then `list` again

## A tool sets DTR, RTS or parity

- Start it under the shim: `jupyterlab-device run --device <name> -- <tool> ...`
- The tool appears in the Devices panel while it runs; the user can stop it there, which sends SIGHUP and SIGKILL 3 s later

## A USB device through pyusb

1. Grant the device as above
2. `jupyterlab-device usb list`, then `jupyterlab-device usb open <device>`, then `jupyterlab-device usb claim <device> <interface>`
3. A pyusb program calls `jupyterlab_device_bridge_extension.pyusb_backend.get_backend()` or `install()`
4. `jupyterlab-device usb close <device>` - open and claimed interfaces last until this call

## Save a working configuration

- After `settings set` produced values that work: `jupyterlab-device settings save <device> "My board"`
- Later: `jupyterlab-device settings apply <device> "My board"`
