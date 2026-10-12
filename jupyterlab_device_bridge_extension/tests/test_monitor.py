"""Tests of the monitor buffer."""

import asyncio
import time

from jupyterlab_device_bridge_extension.monitor import MonitorBuffer

LIMIT = 1000


async def test_acc_mon_40_buffer_keeps_its_size_and_drops_the_oldest_bytes():
    """ACC-MON-40 the buffer keeps at most its size, drops the oldest bytes first and says so."""
    data = bytes(index % 251 for index in range(2 * LIMIT))
    buffer = MonitorBuffer(LIMIT)
    buffer.append(data[:700])
    buffer.append(data[700:])

    chunk = await buffer.read()

    assert len(chunk["data"]) == LIMIT
    assert chunk["data"] == data[LIMIT:]
    assert (chunk["start"], chunk["next"]) == (LIMIT, 2 * LIMIT)
    assert chunk["dropped"] is True


async def test_acc_mon_40_dropped_only_when_bytes_after_since_are_gone():
    """ACC-MON-40 a reader whose offset is still in the buffer loses nothing and is told so."""
    data = bytes(index % 251 for index in range(2 * LIMIT))
    buffer = MonitorBuffer(LIMIT)
    buffer.append(data)

    assert await buffer.read(since=LIMIT) == {
        "data": data[LIMIT:], "start": LIMIT, "next": 2 * LIMIT, "dropped": False}
    assert await buffer.read(since=1500) == {
        "data": data[1500:], "start": 1500, "next": 2 * LIMIT, "dropped": False}
    assert (await buffer.read(since=LIMIT - 1))["dropped"] is True
    assert await buffer.read(since=2 * LIMIT) == {
        "data": b"", "start": 2 * LIMIT, "next": 2 * LIMIT, "dropped": False}


async def test_acc_mon_39_bytes_appended_before_the_read_are_returned():
    """ACC-MON-39 bytes that arrived before a read are in its answer, from offset 0."""
    buffer = MonitorBuffer(LIMIT)
    buffer.append(b"boot\n")
    buffer.append(b"\x00\xffready\n")

    assert await buffer.read() == {
        "data": b"boot\n\x00\xffready\n", "start": 0, "next": 13, "dropped": False}


async def test_acc_mon_42_a_waiting_read_returns_when_bytes_arrive():
    """ACC-MON-42 a read that waits returns the new bytes as soon as they arrive."""
    buffer = MonitorBuffer(LIMIT)
    buffer.append(b"old")
    asyncio.get_running_loop().call_later(0.1, buffer.append, b"new")

    started = time.monotonic()
    chunk = await buffer.read(since=3, wait=5)

    assert chunk == {"data": b"new", "start": 3, "next": 6, "dropped": False}
    assert 0.05 < time.monotonic() - started < 2


async def test_acc_mon_42_a_waiting_read_ends_at_its_time():
    """ACC-MON-42 a read that waits returns no bytes when its time ends, and waits not at all for bytes it has."""
    buffer = MonitorBuffer(LIMIT)
    buffer.append(b"old")

    started = time.monotonic()
    chunk = await buffer.read(since=3, wait=0.2)
    waited = time.monotonic() - started

    assert chunk == {"data": b"", "start": 3, "next": 3, "dropped": False}
    assert 0.15 < waited < 1
    started = time.monotonic()
    assert (await buffer.read(since=0, wait=5))["data"] == b"old"
    assert time.monotonic() - started < 0.1


async def test_acc_mon_42_an_offset_of_an_earlier_server_reads_from_the_newest_byte():
    """ACC-MON-42 a reader that follows with an offset past the buffer's end gets the bytes that arrive next."""
    buffer = MonitorBuffer(LIMIT)
    buffer.append(b"abc")
    asyncio.get_running_loop().call_later(0.05, buffer.append, b"def")

    assert await buffer.read(since=5000, wait=5) == {
        "data": b"def", "start": 3, "next": 6, "dropped": False}
