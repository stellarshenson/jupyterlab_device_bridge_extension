"""Monitor buffer: the most recent bytes one serial port sent.

A short-lived program reads output that arrived before it started. Every byte has
an absolute offset that only grows, so a reader asks for "everything after offset
N" and learns whether bytes it has not seen have already left the buffer.
"""

import asyncio
import contextlib


class MonitorBuffer:
    """Ring buffer of the bytes a port sent.

    Args:
        limit: Most bytes kept; the oldest bytes leave first.
    """

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._data = bytearray()
        self._end = 0  # offset one past the newest byte
        self._arrived = asyncio.Event()

    def append(self, data: bytes) -> None:
        """Add bytes the port sent and wake the readers that wait for them."""
        if not data:
            return
        self._data += data
        self._end += len(data)
        del self._data[:max(0, len(self._data) - self._limit)]
        # set() wakes the readers that wait now; clear() makes a later reader wait
        # for later bytes.
        self._arrived.set()
        self._arrived.clear()

    async def read(self, since: int = 0, wait: float = 0.0) -> dict:
        """The bytes after an offset.

        Args:
            since: Absolute offset to read from. An offset past the newest byte,
                as a reader of an earlier server holds, reads from the newest byte.
            wait: Seconds to wait for new bytes when there are none after `since`.

        Returns:
            `{data: bytes, start, next, dropped}`: `start` is the offset of the
            first byte in `data`, `next` the offset to pass as the next `since`,
            and `dropped` is true when bytes after `since` have left the buffer.
        """
        since = min(since, self._end)
        if since == self._end and wait > 0:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._arrived.wait(), wait)
        oldest = self._end - len(self._data)
        start = max(since, oldest)
        return {"data": bytes(self._data[start - oldest:]), "start": start,
                "next": self._end, "dropped": start > since}
