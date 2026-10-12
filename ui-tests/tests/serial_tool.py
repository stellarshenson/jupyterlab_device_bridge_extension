"""A serial tool for the functional tests, standard library only.

It does on a virtual serial device what an upload tool does on a serial port: opens
the path, makes the line raw at a baud rate, sets control lines, writes bytes and
reads bytes. It prints one JSON document on stdout:

    {"signals": ["ok" or the errno name of each control line call], "read": "<hex>"}

    serial_tool.py PATH [--baud N] [--signals dtr=1 rts=0 ...] [--write HEX]
                        [--read N] [--hold]

With --hold the tool keeps the device open after it printed, until a line arrives
on stdin.
"""

import argparse
import errno
import fcntl
import json
import os
import select
import struct
import sys
import termios
import time

BAUDS = {9600: termios.B9600, 19200: termios.B19200, 57600: termios.B57600,
         115200: termios.B115200}
LINES = {"dtr": termios.TIOCM_DTR, "rts": termios.TIOCM_RTS}
READ_TIMEOUT_S = 15.0


def make_raw(fd: int, baud: int) -> None:
    """Make the line raw (no echo, no translation) with 8 data bits at `baud`."""
    settings = termios.tcgetattr(fd)
    settings[0] = settings[1] = settings[3] = 0  # input, output and local flags
    settings[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    settings[4] = settings[5] = BAUDS[baud]
    settings[6][termios.VMIN], settings[6][termios.VTIME] = 1, 0
    termios.tcsetattr(fd, termios.TCSANOW, settings)


def set_line(fd: int, step: str) -> str:
    """Set one control line, for example `dtr=1`; returns `ok` or the errno name."""
    line, level = step.split("=")
    request = termios.TIOCMBIS if level == "1" else termios.TIOCMBIC
    try:
        fcntl.ioctl(fd, request, struct.pack("i", LINES[line]))
    except OSError as error:
        return errno.errorcode[error.errno]
    return "ok"


def read_bytes(fd: int, count: int) -> bytes:
    """Read `count` bytes; fewer when no byte arrives for `READ_TIMEOUT_S`."""
    data = b""
    deadline = time.monotonic() + READ_TIMEOUT_S
    while len(data) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            break
        data += os.read(fd, count - len(data))
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("path")
    parser.add_argument("--baud", type=int, choices=sorted(BAUDS), default=115200)
    parser.add_argument("--signals", nargs="*", default=[], metavar="LINE=LEVEL")
    parser.add_argument("--write", default="", metavar="HEX")
    parser.add_argument("--read", type=int, default=0, metavar="N")
    parser.add_argument("--hold", action="store_true")
    args = parser.parse_args()

    fd = os.open(args.path, os.O_RDWR | os.O_NOCTTY)
    make_raw(fd, args.baud)
    signals = [set_line(fd, step) for step in args.signals]
    os.write(fd, bytes.fromhex(args.write))
    data = read_bytes(fd, args.read)
    print(json.dumps({"signals": signals, "read": data.hex()}), flush=True)
    if args.hold:
        sys.stdin.readline()
    os.close(fd)


if __name__ == "__main__":
    main()
