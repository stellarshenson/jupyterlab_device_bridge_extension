"""Virtual serial device: one pty pair that a serial tool opens as a serial port.

The tool opens the pty slave through a symlink in the device directory. The bridge
keeps the master: through it the bridge sees a tool open and close the device,
reads the baud rate the tool sets, and moves the bytes.

Linux only: the speed is read and set with the termios2 calls, which carry any baud
rate as a plain number, and the holder of the device is found in /proc.
"""

import asyncio
import contextlib
import errno
import fcntl
import os
import select
import stat
import struct
import termios
from typing import Protocol

READ_BYTES = 65536  # most bytes taken from the tool in one chunk
QUEUE_BYTES = 8 * 1024 * 1024  # most bytes kept for a tool that does not read
POLL_S = 0.02  # how often the master is asked whether a tool holds the slave

# struct termios2 of asm-generic (x86, ARM, RISC-V): four flag words, c_line, c_cc[19],
# then the input and the output speed as plain numbers.
_TERMIOS2 = struct.Struct("4IB19s2I")
_TCGETS2, _TCSETS2 = 0x802C542A, 0x402C542B
_BOTHER = 0o010000  # c_cflag: the speed is the number in the speed fields


class DeviceDirError(OSError):
    """The device directory is refused; the message says why."""


class ToolListener(Protocol):
    """What a `VirtualSerial` reports about the tool on its slave."""

    def tool_opened(self, holder: dict | None, baud: int) -> None:
        """A tool opened the device. `holder` is `{pid, name}`, None when no process is found."""

    def tool_baud(self, baud: int) -> None:
        """The tool that holds the device set another baud rate."""

    def tool_data(self, chunk: bytes) -> None:
        """The tool wrote bytes for the port."""

    def tool_closed(self) -> None:
        """The last tool closed the device."""


def ensure_dir(path: str) -> None:
    """Create a directory with mode 0700 when it is missing, and check it before it is used.

    Raises:
        DeviceDirError: `path` is not a real directory (a symlink is refused), or
            another user owns it.
        OSError: The directory cannot be created.
    """
    with contextlib.suppress(FileExistsError):
        os.mkdir(path, 0o700)
    status = os.lstat(path)
    if not stat.S_ISDIR(status.st_mode):
        raise DeviceDirError(f"{path} is not a directory; a symlink is refused too")
    if status.st_uid != os.getuid():
        raise DeviceDirError(
            f"{path} is owned by uid {status.st_uid}, not by uid {os.getuid()} of this server")


def lock_dir(path: str) -> int | None:
    """Take the exclusive lock on a device directory.

    The lock is a `flock` on the directory itself, so the directory gets no file for it.
    The kernel releases the lock when the process ends, also when the process is killed.
    So the lock is refused only while a live process holds it.

    Args:
        path: The device directory. It is made when it is missing, and checked with `ensure_dir`.

    Returns:
        The descriptor that holds the lock until it is closed; None when another
        process holds the lock.

    Raises:
        DeviceDirError: The directory is refused.
        OSError: The directory cannot be made or opened.
    """
    ensure_dir(path)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def remove_left(device_dir: str, shim_dir: str) -> None:
    """Remove what a server that ended without its exit hook left in a device directory.

    That is every symlink to a pty slave (a target under `/dev/pts/`) in the device
    directory and every socket in its shim directory. Any other symlink, a directory
    and a regular file stay, and so does the entry of the shim directory itself. Call
    it only while this process holds the lock of `lock_dir`:
    otherwise the symlinks and sockets can be those of the live server that holds it.

    Raises:
        OSError: An entry cannot be read or removed.
    """
    for name in os.listdir(device_dir):
        path = os.path.join(device_dir, name)
        # The bridge makes no other link than one to a pty slave (`_open_pty`).
        if path != shim_dir and os.path.islink(path) and os.readlink(path).startswith("/dev/pts/"):
            os.unlink(path)
    if not os.path.lexists(shim_dir):
        return
    # A shim directory that is refused is reported when a port starts its shim socket.
    with contextlib.suppress(DeviceDirError):
        ensure_dir(shim_dir)
        for name in os.listdir(shim_dir):
            path = os.path.join(shim_dir, name)
            if stat.S_ISSOCK(os.lstat(path).st_mode):
                os.unlink(path)


def read_speed(fd: int) -> int:
    """The baud rate of the pty behind `fd`, the master or the slave."""
    return _TERMIOS2.unpack(fcntl.ioctl(fd, _TCGETS2, bytes(_TERMIOS2.size)))[-1]


def set_raw(fd: int, baud: int) -> None:
    """Make the pty behind `fd` a raw 8-bit line at `baud`.

    Raw means no echo, no line discipline and no CR or LF translation. A fresh pty
    has all three, and with echo every byte from the port goes back to the port.
    """
    *_, line, control, _, _ = _TERMIOS2.unpack(fcntl.ioctl(fd, _TCGETS2, bytes(_TERMIOS2.size)))
    control = bytearray(control)
    control[termios.VMIN], control[termios.VTIME] = 1, 0
    cflag = termios.CS8 | termios.CREAD | termios.CLOCAL | _BOTHER
    fcntl.ioctl(fd, _TCSETS2, _TERMIOS2.pack(0, 0, cflag, 0, line, bytes(control), baud, baud))


def _holds(pid: int, slave_path: str) -> bool:
    """Whether a process has the pty slave open."""
    fd_dir = f"/proc/{pid}/fd"
    for fd in os.listdir(fd_dir):
        # A descriptor that the process closed meanwhile cannot be read.
        with contextlib.suppress(OSError):
            if os.readlink(f"{fd_dir}/{fd}") == slave_path:
                return True
    return False


def find_holder(slave_path: str) -> dict | None:
    """The process that has a pty slave open.

    Args:
        slave_path: The slave, for example `/dev/pts/7`.

    Returns:
        `{pid, name}` of the process with the lowest pid, or None when no process
        that this user can inspect has the slave open.
    """
    for pid in sorted(int(entry) for entry in os.listdir("/proc") if entry.isdigit()):
        # A process of another user, or one that ended meanwhile, cannot be read.
        with contextlib.suppress(OSError):
            if _holds(pid, slave_path):
                with open(f"/proc/{pid}/comm", encoding="utf-8", errors="replace") as comm:
                    return {"pid": pid, "name": comm.read().strip()}
    return None


class VirtualSerial:
    """One pty pair and the symlink a tool opens.

    Bytes from the port reach the slave only while a tool holds it, and the slave's
    input queue is emptied when the tool closes it, so the next tool never reads
    bytes of an earlier time. Must be created on the running event loop.

    Args:
        path: Where the symlink to the pty slave is made; a link left there is replaced.
            Its directory is the device directory: it is made when it is missing and
            checked with `ensure_dir` before every link.
        baud: Speed of the device while no tool holds it.
        listener: Told when a tool opens, sets a speed, writes and closes.

    Attributes:
        held: A tool holds the device now.
        slave_path: The pty slave, for example `/dev/pts/7`.
        minor: The number of the pty slave. Both change when a tool left the slave
            unusable and the device took a new pty; `path` never changes.

    Raises:
        DeviceDirError: The device directory is refused.
        OSError: The pty or the symlink cannot be made.
    """

    def __init__(self, path: str, baud: int, listener: ToolListener) -> None:
        self.path = path
        self.held = False
        self._listener = listener
        self._baud = baud  # speed while no tool holds the device
        self._speed = baud  # speed last read from the pty
        self._pending = bytearray()  # bytes from the port that the tool has not taken yet
        self._loop = asyncio.get_running_loop()
        self._open_pty()
        self._timer = self._loop.call_later(POLL_S, self._poll)

    def set_baud(self, baud: int) -> None:
        """Set the speed of the device while no tool holds it."""
        self._baud = baud
        if not self.held:
            set_raw(self._master, baud)
            self._speed = baud

    def speed(self) -> int:
        """Read the baud rate on the device now: the tool's own while a tool holds it.

        A rate read here is not reported through `tool_baud` again.
        """
        # Speed 0 is the hang-up request of a tool, not a baud rate for the port.
        self._speed = read_speed(self._master) or self._speed
        return self._speed

    def write(self, data: bytes) -> None:
        """Give bytes from the port to the tool, in order.

        Bytes are dropped while no tool holds the device, and beyond `QUEUE_BYTES`
        that the tool has not taken.
        """
        if not self.held:
            return
        if not self._pending:
            self._loop.add_writer(self._master, self._writable)
        self._pending += data[:QUEUE_BYTES - len(self._pending)]

    def check_open(self) -> None:
        """Look now whether a tool opened the device; `tool_opened` is called when one did."""
        if self.held or self._master < 0:
            return
        events = self._poller.poll(0)
        mask = events[0][1] if events else 0
        # POLLHUP absent: a tool has the slave open. POLLIN with POLLHUP: a tool
        # opened the slave, wrote and closed it between two polls.
        if not mask & select.POLLHUP or mask & select.POLLIN:
            self._opened()

    def close(self) -> None:
        """Remove the symlink and release the pty."""
        self._timer.cancel()
        self._loop.remove_reader(self._master)
        self._loop.remove_writer(self._master)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)
        os.close(self._master)
        self._master = -1  # a line of the shim can still arrive: check_open then does nothing

    def _open_pty(self) -> None:
        """Make a pty pair, raw at the device's own speed, and point the symlink at its slave."""
        ensure_dir(os.path.dirname(self.path))
        master, slave = os.openpty()
        try:
            os.set_blocking(master, False)
            set_raw(slave, self._baud)
            slave_path = os.ttyname(slave)
            minor = os.minor(os.fstat(slave).st_rdev)
            with contextlib.suppress(FileNotFoundError):
                os.unlink(self.path)
            os.symlink(slave_path, self.path)
        except OSError:
            os.close(master)
            raise
        finally:
            # The master reports POLLHUP only after a slave was opened and closed once.
            # From here POLLHUP means: no tool holds the device.
            os.close(slave)
        self._master, self.slave_path, self.minor = master, slave_path, minor
        self._poller = select.poll()
        self._poller.register(master, select.POLLIN)

    def _poll(self) -> None:
        self._timer = self._loop.call_later(POLL_S, self._poll)
        if self.held:
            # A tool that only reads writes nothing; its baud rate is seen here.
            self._read_speed()
            return
        self.check_open()

    def _opened(self) -> None:
        self.held = True
        # The master is watched for reading only while a tool holds the slave: a
        # hung-up descriptor is readable all the time and makes the event loop spin.
        self._loop.add_reader(self._master, self._readable)
        self._listener.tool_opened(find_holder(self.slave_path), self.speed())

    def _read_speed(self) -> None:
        before = self._speed
        if self.speed() != before:
            self._listener.tool_baud(self._speed)

    def _readable(self) -> None:
        try:
            chunk = os.read(self._master, READ_BYTES)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            # EIO: the last tool closed the slave and all it wrote is read.
            self._closed()
            return
        # Read after the chunk and before it is passed on: a baud rate the tool set
        # before it wrote these bytes travels ahead of them.
        self._read_speed()
        self._listener.tool_data(chunk)

    def _writable(self) -> None:
        try:
            sent = os.write(self._master, self._pending)
        except BlockingIOError:
            return
        del self._pending[:sent]
        if not self._pending:
            self._loop.remove_writer(self._master)

    def _closed(self) -> None:
        self.held = False
        self._loop.remove_reader(self._master)
        self._loop.remove_writer(self._master)
        self._pending.clear()
        self._reset()
        self._listener.tool_closed()

    def _reset(self) -> None:
        """Make the device raw again at its own speed and empty the slave's input queue.

        The tool may have left echo or a line discipline behind, and bytes from the
        port that it did not read. Only a flush on the slave itself empties that
        queue, so the bridge opens the slave for the moment of the reset.
        """
        self._speed = self._baud
        try:
            slave = os.open(self.slave_path, os.O_RDWR | os.O_NOCTTY)
        except OSError as error:
            if error.errno != errno.EBUSY:
                raise
            # A tool set exclusive mode (TIOCEXCL) and ended without clearing it. The
            # mode stays on the slave for as long as the master is open, and nothing
            # opens that slave again. A new pty takes its place at the same path.
            unusable = self._master
            self._open_pty()
            os.close(unusable)
            return
        try:
            set_raw(slave, self._baud)
            termios.tcflush(slave, termios.TCIFLUSH)
        finally:
            os.close(slave)
