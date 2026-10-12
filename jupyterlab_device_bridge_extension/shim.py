"""Socket side of the preload shim.

Each virtual serial device has one Unix socket, `<device_dir>/.shim/pts-<minor>.sock`.
The shim library in a tool's process (`shim/devshim.c`) connects to it and sends one
line per event; the bridge answers `ok` once the browser tab applied the event, so the
tool's next call runs after it.

    S <dtr 0|1> <rts 0|1>              modem lines
    B <0|1>                            break
    T <dataBits> <N|E|O> <stopBits>    frame format
"""

import asyncio
import contextlib
import os
from collections.abc import Awaitable, Callable

ANSWER_S = 1.0  # the answer is not held back longer than this
_LEVELS = {"0": False, "1": True}
_PARITIES = {"N": "none", "E": "even", "O": "odd"}


def parse(line: bytes) -> tuple[str, dict] | None:
    """One event line of the shim.

    Returns:
        `("signals", {dtr, rts})`, `("signals", {brk})` or
        `("frame", {dataBits, parity, stopBits})`; None for a line that is none of the three.
    """
    try:
        kind, *fields = line.decode("ascii").split()
        if kind == "S":
            dtr, rts = (_LEVELS[field] for field in fields)
            return "signals", {"dtr": dtr, "rts": rts}
        if kind == "B":
            (brk,) = (_LEVELS[field] for field in fields)
            return "signals", {"brk": brk}
        if kind == "T":
            data_bits, parity, stop_bits = fields
            return "frame", {"dataBits": int(data_bits), "parity": _PARITIES[parity],
                             "stopBits": int(stop_bits)}
    except (ValueError, KeyError):
        pass
    return None


class ShimSocket:
    """The Unix socket of one pty of a virtual serial device.

    Args:
        directory: Where the socket is made, as `pts-<minor>.sock` with mode 0600.
        minor: The number of the pty slave; the shim finds the socket by it.
        on_event: Called with the two values of `parse` for every event line. It
            returns when the tab applied the event; the answer to the shim does not
            wait longer than `ANSWER_S` for it.
    """

    def __init__(self, directory: str, minor: int,
                 on_event: Callable[[str, dict], Awaitable[None]]) -> None:
        self.minor = minor
        self.path = os.path.join(directory, f"pts-{minor}.sock")
        self._on_event = on_event
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> None:
        """Start listening.

        Raises:
            OSError: The socket cannot be made.
        """
        self._server = await asyncio.start_unix_server(self._serve, path=self.path)
        os.chmod(self.path, 0o600)

    def close(self) -> None:
        """Stop listening and remove the socket."""
        if self._server:
            self._server.close()
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while line := await reader.readline():
                event = parse(line)
                if event:
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(self._on_event(*event), ANSWER_S)
                # Always answered: the answer only orders the tool's calls.
                writer.write(b"ok\n")
                await writer.drain()
        except (ConnectionError, ValueError):
            # The tool went away, or sent a line longer than the stream allows.
            pass
        finally:
            writer.close()
