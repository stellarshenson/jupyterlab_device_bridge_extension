# Board recipes

What works with the device bridge on real boards: one recipe per platform, the exact commands, and what the board did. Only behaviour observed on a board is stated as fact; the rest is marked untested.

## ESP32 with native USB (C3, S3, C6)

Observed on an ESP32-C3 (USB Serial/JTAG, 303a:1001).

- The USB Serial/JTAG peripheral exists on the C3, S3, C6 and P4 only. A classic ESP32 board has an external UART bridge (CP210x or CH340), and the no-reset recipe here does not apply to it
- The USB Serial/JTAG peripheral ignores the DTR/RTS reset esptool performs by default; an upload with the default reset ends `No serial data received`
- Plain form that works: apply the ESP upload config (115200 8N1, open action `esp-bootloader`), then `jupyterlab-device run --device <name> -- esptool --before no-reset write-flash ...`. The config's open action puts the chip in download mode; a 16 KiB write and its hash verification passed
- Shim form that works: `jupyterlab-device run --device <name> -- esptool write-flash ...` with esptool's own reset; the shim passes DTR/RTS to the browser, the chip resets, write and hash verification passed
- PlatformIO: `run --device <name> -- pio run -t upload --upload-port <path>`, with `upload_flags` one per line:

  ```
  upload_flags =
      --before=no_reset
      --after=watchdog_reset
  ```

  PlatformIO's bundled esptool 4.11 takes underscore values (`no_reset`, `watchdog_reset`); standalone esptool 5.6 takes hyphen values (`--before no-reset`). Two flags on one line reach esptool as a single argument and are rejected
- Console: ESP-IDF puts it on UART0; the bridged USB port then shows binary garbage. `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` in `sdkconfig.defaults` moves the console to the bridged port. Built in the C3 test project; the upload after that change did not run, so the console on USB is not yet observed
- After a verified upload the C3 can stay in ROM download: the monitor reads `rst:0x15 (USB_UART_CHIP_RESET),boot:0x4 (DOWNLOAD(USB/UART0/1))` and `waiting for download`. The USB-JTAG maps DTR to the IO0 boot strap, asserted means IO0 low and download, and esp_pylib's polarity is inverted (`PIN_HIGH = False`). Releasing DTR and pulsing RTS did not leave download in the observed run. Replug the USB cable or press RESET: the flashed program then runs and its output appears
- PlatformIO ESP-IDF: a stale `.pio/build` after a framework change fails the build with `Multiple ways to build the same target ... (from components/efuse/esp32c3/... and components/efuse/src/...)`. `pio run -t clean` in the project, then the upload, fixes it. The first ESP-IDF build also downloads ESP-IDF Python tooling (esp-idf-kconfig, esp-pylib, idf-component-manager) into the environment, so it needs network
- The monitor stream of the USB-CDC port carries binary framing noise around the text; filter with `strings`, or read it `--raw` and decode elsewhere

## ESP8266

Observed on a D1 Mini Pro (ESP8266EX, CP210x UART, chip id `0x002a6be1`).

- Plain UART, no native USB. Apply the ESP upload config (115200 8N1, open action `esp-bootloader`); the action puts the chip in download mode when the tool opens the virtual device. With esptool 4.11 and `--before no_reset`, `chip_id` and `flash_id` answer through the bridge: `esptool --port <path> --before no_reset chip_id`
- esptool 4.11, the copy in PlatformIO's `tool-esptoolpy` package, wrote 4096 bytes at `0x700000` under that config and printed `Hash of data verified`:

  ```bash
  jupyterlab-device settings apply <device> "ESP upload"
  esptool --port <path> --before no_reset write_flash 0x700000 payload.bin
  ```

- The same esptool wrote 4096 bytes at `0x701000` under `run --device` with its own reset, through the shim, and printed `Hash of data verified`:

  ```bash
  jupyterlab-device run --device <name> -- esptool --port <path> write_flash 0x701000 payload.bin
  ```

- esptool 5.6 fails this chip's erase with `C400 Failed SPI operation in stub` and `0x0106` from the ROM, at both offsets. esptool 4.11 at the same offset passes, so the tool version is the variable. Use 4.11 for this chip, not the `esptool` on `PATH` here
- esptool before version 5 writes the option value and the subcommand with an underscore: `no_reset`, `write_flash`. Version 5 and later write `no-reset`, `write-flash`

## STM32 serial bootloader

Observed on a Nucleo ST-Link VCP (0483:374b).

- The ROM bootloader speaks 8E1 and autobauds on the sync byte; stm32flash 0.7 defaults to 57600 8E1
- Every pty on this host refuses `PARENB` with EINVAL, a fresh pty as well as the bridge pty, so stm32flash's default 8E1 cannot open the bridge path at all. The wire parity still comes from the port's settings record
- Plain form that works: apply the STM32 bootloader config (115200 8E1), then `stm32flash -b 115200 -m 8n1 <path>`
- Shim form: `jupyterlab-device run --device <name> -- stm32flash ...`; the shim passes the tool's 8E1 to the bridge and keeps it off the pty
- A Nucleo-L152RE does not answer even with BOOT0 high: the on-board ST-Link VCP is wired to USART2 PA2/PA3, while the STM32L1 bootloader uses USART2 on the remapped PD5/PD6, absent on the 64-pin package, or USART1 PA9/PA10. stm32flash ends `Failed to init device, timeout`. Reaching the bootloader needs a USB-UART adapter on USART1: adapter TX to PA10, adapter RX to PA9, GND to GND. ACC-BOARD-101 was rejected for this reason
- BOOT0 on a Nucleo-64 is not a jumper: CN7 pin 5 is VDD and pin 7 is BOOT0, and a shunt across pins 5 and 7 sets BOOT0 high. Spare shunts are stored on CN11 and CN12 on the bottom side. Pin 1 is the square pad at the USB end of the header
- The ST-Link also enumerates an MBED mass-storage volume with `DETAILS.TXT` and `MBED.HTM` for drag-and-drop flashing. Windows owns that drive; the bridge does not expose it

## Arduino

- Uno, Nano, Mega: apply the Arduino upload config (115200 8N1, DTR pulse on open), then avrdude or `pio run -t upload` under `run --device <name> --` with the path `list` prints
- Arduino as ISP: the config is 19200 8N1; the programmer board must not reset on open
- EEPROM: back it up with avrdude under `run --device <name> --`, `-U eeprom:r:<file>:i`; never `pio run -t erase`, which wipes it
- Not yet exercised on this workstation: an Arduino upload and the Arduino as ISP route (ACC-BOARD-100 open)

### Nano bootloaders

The classic Nano shipped with two bootloaders. They differ in the rate at which the bootloader talks after a reset, so the rate that answers identifies the board:

- Old bootloader: ATmegaBOOT, 57600 baud. An upload at 57600 returns the device signature; at 115200 it ends `stk500_recv(): programmer is not responding` or `not in sync`
- New bootloader: Optiboot, 115200 baud. An upload at 115200 returns the device signature; at 57600 it does not
- `jupyterlab-device probe avr <device>` runs avrdude through `run --device` and names the rate that answers
- The chip marking does not tell the two apart. The rate that synchronizes does

Upload form, old bootloader:

```bash
jupyterlab-device settings apply <device> "Arduino upload"
jupyterlab-device run --device <name> -- avrdude -c arduino -p atmega328p -b 57600 -P <path> -U flash:w:firmware.hex:i
```

Upload form, new bootloader:

```bash
jupyterlab-device settings apply <device> "Arduino upload"
jupyterlab-device run --device <name> -- avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i
```

PlatformIO: `board = nanoatmega328` with `upload_speed = 57600` for the old bootloader, `board = nanoatmega328new` with `upload_speed = 115200` for the new one.

**Burn optiboot with an ISP programmer** (manual; no test covers it)

1. Wire the programmer to the Nano's ICSP header: MISO, MOSI, SCK, RESET, VCC and GND. Power the Nano
2. Apply the `Arduino as ISP` config to the programmer's port. The config runs no action on open, so the programmer is not reset
3. Write the optiboot hex of the Arduino AVR core and the Nano fuses. The hex is in the core at `bootloaders/optiboot/optiboot_atmega328.hex`; the Nano fuses in its `boards.txt` are low `0xFF`, high `0xDA`, extended `0xFD`

```bash
jupyterlab-device settings apply <programmer> "Arduino as ISP"
avrdude -c stk500v1 -p atmega328p -P <programmer path> -b 19200 -U flash:w:optiboot_atmega328.hex:i -U lfuse:w:0xFF:m -U hfuse:w:0xDA:m -U efuse:w:0xFD:m
```

- `-c stk500v1` is the protocol of the ArduinoISP sketch and it does not toggle DTR, so the programmer is not reset
- After the burn the board answers at 115200: use the new bootloader form
- Untested: the burn was not run on a board

## Monitor without holding the port

- `jupyterlab-device monitor read <device>` prints the port's ring buffer and works while an upload tool holds the port; `--follow` runs for the whole `--timeout`
