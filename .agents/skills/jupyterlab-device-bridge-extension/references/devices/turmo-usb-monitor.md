# TURMO 3.5 inch USB monitor

The TURMO is a 3.5 inch USB display of 320 x 480 pixels that a host program fills with RGB565 frames over a USB serial port. This file is the worked example of the uniform device reference of the device bridge agent skill, `references/device-reference.md`; the name TURMO is the user's, no descriptor carries it.

## Contents

- [1. Identity](#1.-Identity)
- [2. Connection](#2.-Connection)
- [3. Device protocol](#3.-Device-protocol)
- [4. Device code](#4.-Device-code)
- [5. Host protocol](#5.-Host-protocol)
- [6. Host code](#6.-Host-code)
  - [6.1 turmo.py](#6.1-turmo.py)
  - [6.2 gpu_status.py](#6.2-gpu_status.py)
  - [6.3 dashboard.html](#6.3-dashboard.html)
- [7. Traps and recovery](#7.-Traps-and-recovery)
- [8. Observed and untested](#8.-Observed-and-untested)
- [9. Sources](#9.-Sources)

## 1. Identity

The unit reports itself as `UsbMonitor` of vendor 0x1a86 and speaks revision A of the protocol that the open source turing-smart-screen-python library implements.

| Field | Value |
| --- | --- |
| VID:PID | `1a86:5722`; that vendor 0x1a86 is QinHeng Electronics (WCH) is untested, no source of section 9 states it |
| Product string | `UsbMonitor` |
| Manufacturer string | `2017-2-25` |
| Serial string | `USB35INCHIPSV2` |
| USB | 2.0, device class 2, one configuration, CDC-ACM |
| Model | UsbPCMonitor 3.5, 320 x 480 portrait, from the HELLO reply `01 01 01 01 01 01` and the reply table of `lcd_comm_rev_a.py` (from a source) |
| Protocol family | turing-smart-screen-python revision A |

The two lines of `jupyterlab-device list` for the unit:

```
serial  tty-1a86-5722  attached  /run/devices/tty-1a86-5722  115200 8N1  on open: none  config: custom  free
usb     usb-1a86-5722  attached  1a86:5722  closed  UsbMonitor
```

- **Strings** - `jupyterlab-device list --json` holds `manufacturerName` and `serialNumber` of the USB record
- **Auto-detect** - the revision A code of the library matches the serial string `USB35INCHIPSV2` or `1a86:5722` (from a source)
- **Manufacturer variant** - another unit with the same ids, product and serial strings reports the manufacturer `Turing` (from a source); this unit, with the manufacturer `2017-2-25`, renders revision A frames (section 8)
- **Other revisions** - revision B uses HELLO `ca` with the ASCII text `HELLO` and 10-byte frames, revision C takes BGR pixels (from a source); this unit renders revision A frames, so neither applies

## 2. Connection

The host program writes to the virtual serial device of the bridge; the lab tab holds the COM port through Web Serial.

- **Path** - `/run/devices/tty-1a86-5722`
- **Settings** - 115200 8N1, action on open `none`
- **Flow control** - the reference library opens the port with RTS/CTS (from a source, `lcd_comm.py` of section 9); the bridge opens it with none, and HELLO is answered
- **Interfaces** - interface 0 CDC Communication with interrupt IN endpoint 1 of 8 bytes; interface 1 CDC Data with bulk IN and bulk OUT endpoint 2 of 64 bytes
- **USB record** - `usb-1a86-5722` is in the table and not used; the Windows serial driver holds the CDC interfaces (untested here), and WebUSB cannot claim an interface another driver holds (untested here)
- **Open** - `O_RDWR | O_NOCTTY`, then raw mode; raw mode keeps the pty from turning `0a` into `0d 0a`; the pty test of ACC-CLI-247 reads all 256 byte values back unchanged
- **One writer** - during a frame no other program writes to the path, `jupyterlab-device terminal` and `monitor write` included

## 3. Device protocol

The panel takes six-byte command packets with four 10-bit coordinates and answers only HELLO. Everything in this section is from the sources of section 9; section 8 lists what this unit did.

- **Packet** - `b0 = x >> 2`, `b1 = (x & 3) << 6 | y >> 4`, `b2 = (y & 15) << 4 | ex >> 6`, `b3 = (ex & 63) << 2 | ey >> 8`, `b4 = ey & 255`, `b5 = command`
- **Rectangle** - (x, y) is the top-left corner and (ex, ey) the bottom-right corner, both inclusive
- **Framing** - no length field, no checksum, no terminator

| Command | Code | Bytes | Reply |
| --- | --- | --- | --- |
| HELLO | `45` | `45 45 45 45 45 45` | six bytes, table below |
| SET_ORIENTATION | `79` | `00 00 00 00 00 79 64 01 40 01 e0 00 00 00 00 00` (portrait) | none |
| SET_BRIGHTNESS | `6e` | `0c c0 00 00 00 6e` (level 80) | none |
| DISPLAY_BITMAP | `c5` | `00 00 04 fd df c5` (320 x 480), then 307200 pixel bytes | none |
| RESET | `65` | `00 00 00 00 00 65` | none; the USB device can re-enumerate |
| CLEAR | `66` | the packet with command `66`, white screen | none |
| TO_BLACK | `67` | the packet with command `67` | none |
| SCREEN_OFF, SCREEN_ON | `6c`, `6d` | the packet with the command | none |
| DISPLAY_PIXELS, SET_MIRROR | `c3`, `7a` | the packet with the command | none |

| HELLO reply | Model |
| --- | --- |
| `01 01 01 01 01 01` | UsbPCMonitor 3.5, 320 x 480 |
| `02 02 02 02 02 02` | UsbPCMonitor 5, 480 x 800 |
| `03 03 03 03 03 03` | UsbPCMonitor 7, 600 x 1024 |
| any other | Turing Smart Screen 3.5, 320 x 480 |

- **SET_ORIENTATION** - 16 bytes: the packet, then `100 + orientation` (portrait `64`, reverse portrait `65`, landscape `66`, reverse landscape `67`), width `01 40` and height `01 e0` big-endian, five zero bytes; older library versions sent 11 bytes
- **SET_BRIGHTNESS** - the value is in the x field: `int(255 - level / 100 * 255)`; 0 is the brightest, 255 the darkest; level 80 gives 51
- **DISPLAY_BITMAP** - the header, then exactly `(ex - x + 1) * (ey - y + 1) * 2` bytes of RGB565 little-endian, row-major from the top-left corner
- **Full frame** - overwrites every pixel; CLEAR and TO_BLACK are not needed first
- **Parser** - the firmware reads a command from the start of a USB transfer and ignores the rest of that transfer
- **Pixel count** - after a bitmap header the firmware counts the pixel bytes of the rectangle; one lost or extra byte makes it take every later command as pixels until a power cycle; such a panel is called desynchronised
- **Timing** - 50 ms after SET_ORIENTATION and 20 ms after the bitmap header are the working pauses of the sources

| Colour | RGB888 | RGB565 value | Bytes on the wire |
| --- | --- | --- | --- |
| red | `ff 00 00` | `f800` | `00 f8` |
| green | `00 ff 00` | `07e0` | `e0 07` |
| blue | `00 00 ff` | `001f` | `1f 00` |
| white | `ff ff ff` | `ffff` | `ff ff` |

- **RGB565** - `(r >> 3) << 11 | (g >> 2) << 5 | b >> 3`, low byte first

## 4. Device code

The panel runs closed vendor firmware, UsbPCMonitor; its source is not available in any source of section 9, and the bridge has no update path for it.

- **Vendor application** - `UsbPCMonitor.exe` with `UsbPCDisplay.dll`, Windows, versions 2.2.5 and 2.1.4 published (from a source)
- **Vendor binaries** - the .NET IL of the application was unreadable and the DLL is UPX-compressed; no command bytes were recovered from them (from a source)
- **Protocol origin** - section 3 comes from the open source host drivers: turing-smart-screen-python, ch340disp in C, turing-smart-screen in Rust
- **Project firmware** - none; the project holds host code only

## 5. Host protocol

The bridge carries a byte stream: the server reads up to 65536 bytes from the pty and sends each read as one WebSocket frame, and the tab writes each frame to the port with one write. Whether each read leaves Chrome and the Windows driver as one USB transfer is untested; the host program writes each part alone, drains it and pauses before the next part.

| Step | Bytes | Write | Pause after |
| ---: | --- | --- | --- |
| 1 | HELLO `45 45 45 45 45 45` | 6 bytes, then read the 6-byte reply, timeout 1.5 s | 100 ms |
| 2 | SET_ORIENTATION portrait | 16 bytes | 50 ms |
| 3 | SET_BRIGHTNESS level 80 | 6 bytes | 50 ms |
| 4 | DISPLAY_BITMAP header `00 00 04 fd df c5` | 6 bytes | 20 ms |
| 5 | pixels | 120 writes of 2560 bytes | 20 ms after each |
| **Total** | | **307234 bytes in 124 writes** | |

- **Write** - one `os.write` loop for the part, then `tcdrain`, then the pause
- **Chunk** - 2560 bytes are 4 rows of pixels and 40 times the 64-byte packet size of bulk OUT endpoint 2
- **HELLO check** - a reply other than `01 01 01 01 01 01` stops the send before any other byte
- **Before** - the device line of `jupyterlab-device list` says `attached` and `free`, and no other writer is open
- **No reset** - the send never writes RESET or CLEAR
- **Counter** - the `tx` of the serial record in `jupyterlab-device list --json` rises by 307234 for one frame
- **Recovery** - a panel that ignores frames can be desynchronised (from a source, turing-smart-screen-python issue #7; on this unit the cause is untested, section 8): the user unplugs and replugs the USB cable, re-adds the device in the Devices panel if the grant dropped, then HELLO and the strict send run again

## 6. Host code

The host program is three files saved side by side in one folder of the project: `turmo.py` (the protocol, standard library only), `gpu_status.py` (the GPU status frame) and `dashboard.html` (the page it renders).

```bash
python3 turmo.py hello --device /run/devices/tty-1a86-5722
python3 turmo.py send --device /run/devices/tty-1a86-5722 frame.rgb565
python3 gpu_status.py --dry-run --out gpu_status.png
python3 gpu_status.py --device /run/devices/tty-1a86-5722
```

- **turmo.py** - packet builders, RGB565, the strict send over a file descriptor, HELLO with a timeout, and the commands `hello` and `send`
- **gpu_status.py** - one nvidia-smi sample, the page rendered by Playwright Chromium at device scale 2 and downscaled to 320 x 480 with Pillow, then the strict send; `--dry-run --out PNG` renders and sends nothing
- **Needs** - `turmo.py` needs Python 3 only; `gpu_status.py` needs nvidia-smi, the Python packages playwright and Pillow, and the Chromium of Playwright

### 6.1 turmo.py

Save as `turmo.py`.

```python
"""Drive the TURMO 3.5 inch USB monitor (revision A protocol) through the device bridge.

Standard library only. The protocol is revision A of turing-smart-screen-python
(lcd_comm_rev_a.py). The sources state that the panel answers HELLO and no
other command. Every command, the bitmap header and every pixel chunk go in a
write of their own with a pause after it; that the bridge then reads each one
alone from the pty is untested.

  python3 turmo.py hello --device /run/devices/tty-1a86-5722
  python3 turmo.py send --device /run/devices/tty-1a86-5722 frame.rgb565
"""

import argparse
import os
import select
import termios
import time
import tty

DEVICE = "/run/devices/tty-1a86-5722"
WIDTH = 320
HEIGHT = 480
FRAME_BYTES = WIDTH * HEIGHT * 2  # 307200
CHUNK = 2560  # 40 times the 64-byte packet size of bulk OUT endpoint 2
BRIGHTNESS = 80  # percent
HELLO_REPLY = bytes([0x01] * 6)  # UsbPCMonitor 3.5, 320 x 480 in the reply table of lcd_comm_rev_a.py

HELLO = 0x45
SET_ORIENTATION = 0x79
SET_BRIGHTNESS = 0x6E
DISPLAY_BITMAP = 0xC5
PORTRAIT = 100


def packet(x: int, y: int, ex: int, ey: int, command: int) -> bytes:
    """A six-byte command: four 10-bit coordinates, both corners inclusive, then the command code."""
    return bytes([
        x >> 2,
        ((x & 3) << 6) | (y >> 4),
        ((y & 15) << 4) | (ex >> 6),
        ((ex & 63) << 2) | (ey >> 8),
        ey & 255,
        command,
    ])


def hello() -> bytes:
    return bytes([HELLO] * 6)


def orientation_portrait() -> bytes:
    """SET_ORIENTATION, 16 bytes: the packet, portrait, width and height big-endian, five zero bytes."""
    return (packet(0, 0, 0, 0, SET_ORIENTATION) + bytes([PORTRAIT])
            + WIDTH.to_bytes(2, "big") + HEIGHT.to_bytes(2, "big") + bytes(5))


def brightness(level: int) -> bytes:
    """SET_BRIGHTNESS for a level of 0 to 100 percent; the sources give 0 as the brightest value."""
    return packet(int(255 - level / 100 * 255), 0, 0, 0, SET_BRIGHTNESS)


def bitmap_header(x: int, y: int, width: int, height: int) -> bytes:
    """DISPLAY_BITMAP for a rectangle; width * height * 2 pixel bytes follow it."""
    return packet(x, y, x + width - 1, y + height - 1, DISPLAY_BITMAP)


def rgb565(red: int, green: int, blue: int) -> bytes:
    """One pixel, RGB565 little-endian."""
    return (((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)).to_bytes(2, "little")


def to_rgb565(rgb: bytes) -> bytes:
    """RGB888 bytes, row-major from the top-left corner, as the RGB565 bytes of the panel."""
    return b"".join(rgb565(*rgb[i:i + 3]) for i in range(0, len(rgb), 3))


def open_device(path: str) -> int:
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    tty.setraw(fd)
    time.sleep(0.1)  # a pause for the bridge to see the open before the first byte
    return fd


def close_device(fd: int) -> None:
    time.sleep(0.5)  # a pause for the bridge to read the last write before the close
    os.close(fd)


def write_alone(fd: int, data: bytes, pause: float) -> int:
    """Write data in full, drain it with tcdrain, then pause; that the bridge reads it alone is untested."""
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]
    termios.tcdrain(fd)
    time.sleep(pause)
    return len(data)


def read_reply(fd: int, size: int, timeout: float) -> bytes:
    reply = b""
    deadline = time.monotonic() + timeout
    while len(reply) < size:
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([fd], [], [], left)[0]:
            break
        reply += os.read(fd, size - len(reply))
    return reply


def say_hello(fd: int, timeout: float = 1.5) -> bytes:
    """HELLO alone; the reply, empty when the panel does not answer within the timeout in seconds."""
    termios.tcflush(fd, termios.TCIFLUSH)
    write_alone(fd, hello(), 0)
    return read_reply(fd, 6, timeout)


def send_frame(fd: int, frame: bytes) -> int:
    """The strict send of one full frame; returns the number of bytes written, 307234."""
    if len(frame) != FRAME_BYTES:
        raise ValueError(f"a frame is {FRAME_BYTES} bytes, this one is {len(frame)}")
    reply = say_hello(fd)
    if reply != HELLO_REPLY:
        raise RuntimeError(f"HELLO answered {reply.hex(' ') or 'nothing'}: nothing more sent")
    time.sleep(0.1)
    sent = len(hello())
    sent += write_alone(fd, orientation_portrait(), 0.05)
    sent += write_alone(fd, brightness(BRIGHTNESS), 0.05)
    sent += write_alone(fd, bitmap_header(0, 0, WIDTH, HEIGHT), 0.02)
    for start in range(0, FRAME_BYTES, CHUNK):
        sent += write_alone(fd, frame[start:start + CHUNK], 0.02)
    return sent


def main() -> int:
    parser = argparse.ArgumentParser(description="Drive the TURMO 3.5 inch USB monitor through the device bridge.")
    commands = parser.add_subparsers(dest="command", required=True)
    hello_command = commands.add_parser("hello", help="send HELLO and print the reply")
    send_command = commands.add_parser("send", help="send one 320 x 480 RGB565 little-endian frame")
    send_command.add_argument("frame", help="a file of 307200 bytes")
    for command in (hello_command, send_command):
        command.add_argument("--device", default=DEVICE, help="the path that jupyterlab-device list prints")
    args = parser.parse_args()

    fd = open_device(args.device)
    try:
        if args.command == "hello":
            reply = say_hello(fd)
            print(f"reply: {reply.hex(' ') or 'none'}")
            return 0 if reply == HELLO_REPLY else 1
        with open(args.frame, "rb") as file:
            print(f"sent {send_frame(fd, file.read())} bytes")
        return 0
    finally:
        close_device(fd)


if __name__ == "__main__":
    raise SystemExit(main())
```

### 6.2 gpu_status.py

Save as `gpu_status.py` beside `turmo.py`.

```python
"""Show the GPU status of this host on the TURMO panel.

Samples nvidia-smi once, renders dashboard.html in Playwright Chromium at
device scale 2 (640 x 960), downscales the screenshot to 320 x 480 with
Pillow and sends it with the strict send of turmo.py. Needs nvidia-smi, the
Python packages playwright and Pillow, and the Chromium of Playwright.

  python3 gpu_status.py --dry-run --out gpu_status.png
  python3 gpu_status.py --device /run/devices/tty-1a86-5722
"""

import argparse
import csv
import datetime
import io
import pathlib
import socket
import subprocess

from PIL import Image
from playwright.sync_api import sync_playwright

import turmo

PAGE = pathlib.Path(__file__).resolve().parent / "dashboard.html"
FIELDS = ("index", "name", "temperature.gpu", "utilization.gpu", "memory.used", "memory.total",
          "power.draw", "power.limit", "fan.speed", "clocks.sm", "clocks.mem", "driver_version")


def sample() -> dict:
    """One nvidia-smi query; the values stay text, the page reads [N/A] as no value."""
    text = subprocess.run(
        ["nvidia-smi", f"--query-gpu={','.join(FIELDS)}", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True, timeout=60).stdout
    gpus = [dict(zip(FIELDS, (cell.strip() for cell in row))) for row in csv.reader(io.StringIO(text)) if row]
    return {
        "host": socket.gethostname(),
        "time": datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "driver": gpus[0]["driver_version"],
        "gpus": gpus,
    }


def render(snapshot: dict) -> Image.Image:
    """The page at 2x, downscaled to the 320 x 480 frame of the panel."""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": turmo.WIDTH, "height": turmo.HEIGHT}, device_scale_factor=2)
        page.goto(PAGE.as_uri())
        page.evaluate("snapshot => render(snapshot)", snapshot)
        page.evaluate("document.fonts.ready.then(() => true)")
        png = page.screenshot()
        browser.close()
    with Image.open(io.BytesIO(png)) as image:
        return image.convert("RGB").resize((turmo.WIDTH, turmo.HEIGHT), Image.LANCZOS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Show the GPU status of this host on the TURMO panel.")
    parser.add_argument("--device", default=turmo.DEVICE, help="the path that jupyterlab-device list prints")
    parser.add_argument("--dry-run", action="store_true", help="render the frame and send nothing")
    parser.add_argument("--out", help="save the 320 x 480 frame as this PNG file")
    args = parser.parse_args()

    image = render(sample())
    if args.out:
        image.save(args.out)
        print(f"wrote {args.out}")
    if args.dry_run:
        return 0
    frame = turmo.to_rgb565(image.tobytes())
    fd = turmo.open_device(args.device)
    try:
        print(f"sent {turmo.send_frame(fd, frame)} bytes")
    finally:
        turmo.close_device(fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

### 6.3 dashboard.html

Save as `dashboard.html` beside `gpu_status.py`; `gpu_status.py` calls its `render` function with the sample.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GPU STATUS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 320px; height: 480px; overflow: hidden; }
  body {
    display: flex; flex-direction: column; padding: 9px 9px 7px;
    background: #080b0f; color: #e8eef5; font-family: "Public Sans", "DejaVu Sans", sans-serif;
  }
  header, footer { display: flex; align-items: baseline; justify-content: space-between; }
  header { padding-bottom: 7px; border-bottom: 1px solid #222c38; }
  footer { margin-top: 7px; padding-top: 6px; border-top: 1px solid #222c38; font-size: 9px; color: #8593a3; }
  footer b, .host { color: #dbe5ef; }
  .title { padding-left: 7px; border-left: 3px solid #43d17a; font-size: 13px; font-weight: 800; letter-spacing: 2.6px; }
  .mono { font-family: "DejaVu Sans Mono", monospace; }
  .host { font-size: 9px; color: #8593a3; }
  main { flex: 1; display: flex; flex-direction: column; gap: 7px; padding-top: 8px; }
  .card {
    flex: 1; display: flex; flex-direction: column; justify-content: space-between; padding: 8px 10px;
    border: 1px solid #222c38; border-radius: 9px; background: #141b25;
  }
  .top { display: flex; align-items: flex-start; gap: 6px; min-height: 30px; }
  .index { width: 15px; height: 15px; border-radius: 4px; background: #202b38; color: #9fb0c2; font-size: 9px; line-height: 15px; text-align: center; }
  .name { flex: 1; font-size: 11px; font-weight: 600; line-height: 1.16; }
  .temp { font-size: 30px; font-weight: 700; line-height: 0.95; }
  .ok { color: #43d17a; }
  .warm { color: #f0b429; }
  .hot { color: #ff5d5d; }
  .metric { display: flex; align-items: center; gap: 6px; height: 14px; }
  .label { width: 22px; font-size: 8.5px; font-weight: 700; letter-spacing: 0.8px; color: #8593a3; }
  .bar { flex: 1; height: 6px; border-radius: 3px; background: #1b2530; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; }
  .value { width: 92px; font-size: 10px; font-weight: 700; text-align: right; white-space: nowrap; }
  .stats { display: flex; justify-content: space-between; font-size: 10px; font-weight: 700; }
  .stats span span { font-size: 8.5px; color: #8593a3; }
</style>
</head>
<body>
  <header><span class="title">GPU STATUS</span><span class="host mono" id="host"></span></header>
  <main id="cards"></main>
  <footer><span class="mono" id="time"></span><span>driver <b class="mono" id="driver"></b></span></footer>
<script>
function number(text) {
  const value = parseFloat(text);
  return Number.isNaN(value) ? null : value;
}

function shown(value, digits, unit) {
  return value === null ? "-" : value.toFixed(digits) + unit;
}

function bar(label, part, whole, colour, text) {
  const fill = part === null || !whole ? 0 : Math.min(100, 100 * part / whole);
  return `<div class="metric"><span class="label">${label}</span>` +
    `<span class="bar"><i style="width:${fill}%;background:${colour}"></i></span>` +
    `<span class="value mono">${text}</span></div>`;
}

function render(snapshot) {
  document.getElementById("host").textContent = snapshot.host;
  document.getElementById("time").textContent = snapshot.time;
  document.getElementById("driver").textContent = snapshot.driver;
  for (const gpu of snapshot.gpus) {
    const temp = number(gpu["temperature.gpu"]);
    const util = number(gpu["utilization.gpu"]);
    const used = number(gpu["memory.used"]);
    const total = number(gpu["memory.total"]);
    const draw = number(gpu["power.draw"]);
    const limit = number(gpu["power.limit"]);
    const level = temp > 75 ? "hot" : temp >= 60 ? "warm" : "ok";
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML =
      `<div class="top"><span class="index mono">${gpu.index}</span><span class="name"></span>` +
      `<span class="temp mono ${level}">${shown(temp, 0, "&#176;C")}</span></div>` +
      bar("UTIL", util, 100, "#4aa8ff", shown(util, 0, "%")) +
      bar("MEM", used, total, "#2fd6c3",
        `${shown(used === null ? null : used / 1024, 2, "")} / ${shown(total === null ? null : total / 1024, 1, " GB")}`) +
      bar("PWR", draw, limit, "#f0b429", `${shown(draw, 1, "")} / ${shown(limit, 0, " W")}`) +
      `<div class="stats"><span><span>FAN</span> ${shown(number(gpu["fan.speed"]), 0, "%")}</span>` +
      `<span><span>SM CLK</span> ${shown(number(gpu["clocks.sm"]), 0, " MHz")}</span>` +
      `<span><span>MEM CLK</span> ${shown(number(gpu["clocks.mem"]), 0, " MHz")}</span></div>`;
    card.querySelector(".name").textContent = gpu.name;
    document.getElementById("cards").append(card);
  }
}
</script>
</body>
</html>
```

## 7. Traps and recovery

The panel acknowledges only HELLO (from a source, `lcd_comm_rev_a.py` of section 9), so a failed frame shows on the screen only, and only the user sees the screen.

| Trap | Effect | Recovery |
| --- | --- | --- |
| The bitmap header shares a write with pixels | the panel can become desynchronised (from a source, turing-smart-screen-python issue #7) | write the header alone, as section 5 does |
| A second program writes during a frame | one stray byte shifts the pixel count (from a source, turing-smart-screen-python issue #7) | one writer only; `list` shows `free` before the send |
| The panel is desynchronised | it takes later commands, new frames included, as pixels (from a source, turing-smart-screen-python issue #7) | the user unplugs and replugs the USB cable (from a source, turing-smart-screen-python issue #7) |
| RESET `00 00 00 00 00 65` | reaches the panel only while it is not desynchronised (from a source, turing-smart-screen-python issue #7); the USB device can re-enumerate and the COM port can change (from a source, turing-smart-screen-python `config.yaml`) | not a recovery; the power cycle is (from a source, turing-smart-screen-python issue #7) |
| The grant can drop after a re-enumeration or a power cycle (untested here) | the line says `detached`, or the device is missing | the user re-adds the device in the Devices panel; no program grants it |
| The tab re-adds the port | `rx` and `tx` of the record start again from 0 | count from the new value |
| A frame of the wrong size | the pixel count of the panel goes wrong (from a source, turing-smart-screen-python issue #7) | `send_frame` refuses anything other than 307200 bytes |

## 8. Observed and untested

Observed on this one unit on 2026-10-19; the user's eyes were the only check of the screen.

| Observed | Evidence |
| --- | --- |
| Identity `1a86:5722`, product `UsbMonitor`, manufacturer `2017-2-25`, serial `USB35INCHIPSV2` | the device table of the bridge and `jupyterlab-device usb describe usb-1a86-5722` |
| USB descriptors: USB 2.0, device class 2, one configuration; interface 0 CDC Communication with interrupt IN endpoint 1 of 8 bytes; interface 1 CDC Data with bulk IN and bulk OUT endpoint 2 of 64 bytes | the USB record `usb-1a86-5722` of the bridge, read with `jupyterlab-device usb describe usb-1a86-5722` |
| HELLO `45 45 45 45 45 45` was answered `01 01 01 01 01 01` every time | the sender output and the monitor buffer of the bridge |
| A 320 x 480 RGB565 little-endian frame displayed upright in portrait | photo of the panel by the user |
| The frame showed a horizontal wrap: a strip of the right edge, about 40 pixels by photo estimate, at the left edge | photo of the panel by the user |
| That send had one stray byte, 307235 bytes counted for a 307234-byte stream, and its bitmap header shared a write with the first pixels | the `tx` counter of the bridge and the old sender |
| A byte-exact re-send of the same frame showed the same image until the user power-cycled the panel | the `tx` counter of the bridge, 307234 bytes, and report of the user |
| RESET `00 00 00 00 00 65`, from the sources, written once, did not change the screen; the tab's counters started again from 0 | the `tx` counter of the bridge and report of the user |
| After the power cycle the strict send of section 5 wrote 307234 bytes and HELLO was answered `01 01 01 01 01 01` | the `tx` counter of the tab and the sender output |

- **Wrap after the strict send** - untested: the user did not report whether the strict send removed the wrap
- **Wrap cause** - untested: a desynchronised panel (from a source) or a fixed line offset in this unit's firmware; the 40-pixel figure is an estimate from a photo, plus or minus 10 pixels
- **Commands not sent** - CLEAR, TO_BLACK, SCREEN_OFF, SCREEN_ON, DISPLAY_PIXELS, SET_MIRROR and every orientation other than portrait are untested
- **Brightness** - SET_BRIGHTNESS level 80 was sent; its effect on the screen is untested
- **Partial bitmaps** - a rectangle smaller than the full frame is untested
- **Flow control** - the effect of RTS/CTS, which the bridge does not use, is untested
- **WebUSB** - untested: the USB record was never opened

## 9. Sources

The protocol comes from the open source drivers below; the research of 2026-10-19 found no vendor document that describes it.

| Source | Holds |
| --- | --- |
| <https://raw.githubusercontent.com/mathoudebine/turing-smart-screen-python/main/library/lcd/lcd_comm_rev_a.py> | command codes, 10-bit packing, HELLO reply table, brightness, 16-byte orientation, RGB565 little-endian, 2560-byte chunks, auto-detect |
| <https://raw.githubusercontent.com/mathoudebine/turing-smart-screen-python/main/library/lcd/lcd_comm.py> | 115200 baud with RTS/CTS, 320 x 480 |
| <https://raw.githubusercontent.com/mathoudebine/turing-smart-screen-python/main/library/lcd/serialize.py> | RGB565 conversion, little-endian |
| <https://raw.githubusercontent.com/mathoudebine/turing-smart-screen-python/main/config.yaml> | revision A for UsbPCMonitor 3.5, RESET on startup and its warning |
| <https://github.com/mathoudebine/turing-smart-screen-python/issues/7> | this device family: one command per USB transfer, commands taken as pixels, the strict send, the power cycle |
| <https://github.com/mathoudebine/turing-smart-screen-python/issues/263> | 11-byte and 16-byte SET_ORIENTATION |
| <https://github.com/mathoudebine/turing-smart-screen-python/issues/335> | revision A orientation regression |
| <https://github.com/mathoudebine/turing-smart-screen-python/releases/tag/3.3.2> | revision A landscape fix |
| <https://github.com/mathoudebine/turing-smart-screen-python/issues/512> | UsbPCMonitor 3.5 shifted rendering on macOS |
| <https://github.com/mathoudebine/turing-smart-screen-python/issues/499> | distorted values on macOS |
| <https://raw.githubusercontent.com/wiki/mathoudebine/turing-smart-screen-python/Hardware-revisions.md> | revisions, `USB35INCHIPS` and `USB35INCHIPSV2` |
| <https://raw.githubusercontent.com/wiki/mathoudebine/turing-smart-screen-python/Vendor-apps.md> | `UsbPCMonitor.exe`, versions 2.2.5 and 2.1.4 |
| <https://github.com/thomasteoh/ch340disp> | C driver for the same device |
| <https://raw.githubusercontent.com/thomasteoh/ch340disp/main/protocol.c> | the same packing and HELLO reply table |
| <https://raw.githubusercontent.com/thomasteoh/ch340disp/main/display.c> | inclusive bitmap bounds, RGB565 little-endian rows |
| <https://raw.githubusercontent.com/thomasteoh/ch340disp/main/main.c> | open sequence, frames without reset |
| <https://raw.githubusercontent.com/thomasteoh/ch340disp/main/backend_tty.c> | 115200, CS8, CRTSCTS, no DTR or RTS |
| <https://tteoh.com/posts/repurposing-a-usb-display/> | vendor binary findings |
| <https://www.harukadev.com/blog/turzx-35-smart-screen-reverse-engineering> | same descriptors, manufacturer `Turing`, CDC-ACM endpoints |
| <https://docs.rs/turing-smart-screen/latest/src/turing_smart_screen/screen.rs.html> | Rust driver with the same command values |

The datasheets of the parts, for `references/datasheets/`; the research of 2026-10-19 named no datasheet.

| Part | URL | File |
| --- | --- | --- |
| USB controller behind `1a86:5722`, maker untested, part number not identified | not found | not downloaded |
| LCD panel and its driver chip, 3.5 inch 320 x 480, part number not identified | not found | not downloaded |
| Module, UsbPCMonitor 3.5 | not found | not downloaded |
