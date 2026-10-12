/*
 * devshim - the LD_PRELOAD library of jupyterlab_device_bridge_extension.
 *
 * A serial device of the bridge is a pty. A pty refuses the modem line calls
 * (ENOTTY) and drops parity and data bits. This library answers those calls
 * for a bridge pty and passes them to the bridge over the Unix socket
 * $JUPYTERLAB_DEVICE_SHIM_DIR/pts-<minor>.sock, one line per event:
 *
 *     S <dtr 0|1> <rts 0|1>              modem lines
 *     B <0|1>                            break
 *     T <dataBits> <N|E|O> <stopBits>    frame format
 *
 * The bridge answers "ok" once the browser tab applied the event, so the
 * tool's next call runs after it. A descriptor that has no such socket goes
 * to libc unchanged.
 *
 * glibc's tcsetattr and tcgetattr do not call the ioctl symbol, so all three
 * are replaced here.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/time.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

#define PTS_MAJOR 136 /* Unix98 pty slaves; the minor is the pts number */
#define MAX_DEVICES 8
#define FRAME_BITS (CSIZE | PARENB | PARODD | CSTOPB)
/* The bridge answers within 1 s; this only bounds a bridge that stopped. */
#define ANSWER_TIMEOUT_S 3

struct device {
    int used;
    unsigned int minor;
    int modem;       /* TIOCM bits as the tool last set them */
    int frame_known; /* the tool has set a frame format */
    tcflag_t frame;  /* FRAME_BITS of c_cflag as the tool last set them */
};

static struct device devices[MAX_DEVICES];

static int socket_address(unsigned int minor, struct sockaddr_un *address)
{
    const char *dir = getenv("JUPYTERLAB_DEVICE_SHIM_DIR");
    int length;

    if (dir == NULL)
        return -1;
    memset(address, 0, sizeof *address);
    address->sun_family = AF_UNIX;
    length = snprintf(address->sun_path, sizeof address->sun_path, "%s/pts-%u.sock", dir, minor);
    return length > 0 && (size_t)length < sizeof address->sun_path ? 0 : -1;
}

static struct device *remembered(unsigned int minor)
{
    int i;

    for (i = 0; i < MAX_DEVICES; i++)
        if (devices[i].used && devices[i].minor == minor)
            return &devices[i];
    for (i = 0; i < MAX_DEVICES; i++)
        if (!devices[i].used) {
            devices[i].used = 1;
            devices[i].minor = minor;
            return &devices[i];
        }
    return NULL;
}

/* The state of the bridge device behind fd, or NULL when fd is anything else. */
static struct device *bridge_device(int fd)
{
    int saved_errno = errno;
    struct device *device = NULL;
    struct stat status;
    struct sockaddr_un address;
    unsigned int pts;

    if (fstat(fd, &status) == 0 && S_ISCHR(status.st_mode) && major(status.st_rdev) == PTS_MAJOR) {
        pts = minor(status.st_rdev);
        if (socket_address(pts, &address) == 0 && stat(address.sun_path, &status) == 0
            && S_ISSOCK(status.st_mode))
            device = remembered(pts);
    }
    errno = saved_errno;
    return device;
}

/* Send one event line and wait for the answer. 0 when the bridge took the line. */
static int send_event(const struct device *device, const char *line)
{
    int saved_errno = errno;
    struct timeval timeout = {ANSWER_TIMEOUT_S, 0};
    struct sockaddr_un address;
    char answer[8];
    int sent = -1;
    int connection;

    if (socket_address(device->minor, &address) == 0
        && (connection = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)) >= 0) {
        setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
        setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
        /* MSG_NOSIGNAL: a bridge that went away must not kill the tool with SIGPIPE. */
        if (connect(connection, (struct sockaddr *)&address, sizeof address) == 0
            && send(connection, line, strlen(line), MSG_NOSIGNAL) == (ssize_t)strlen(line)) {
            /* The answer only orders the tool's calls; a silent bridge does not fail them. */
            recv(connection, answer, sizeof answer, 0);
            sent = 0;
        }
        close(connection);
    }
    errno = saved_errno;
    return sent;
}

int ioctl(int fd, unsigned long request, ...)
{
    static int (*libc_ioctl)(int, unsigned long, ...);
    struct device *device;
    char line[16];
    va_list arguments;
    void *argument;
    int modem;

    va_start(arguments, request);
    argument = va_arg(arguments, void *);
    va_end(arguments);
    if (libc_ioctl == NULL)
        libc_ioctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");

    switch (request) {
    case TIOCMGET:
        if ((device = bridge_device(fd)) != NULL) {
            *(int *)argument = device->modem;
            return 0;
        }
        break;
    case TIOCMBIS:
    case TIOCMBIC:
    case TIOCMSET:
        if ((device = bridge_device(fd)) != NULL) {
            modem = *(int *)argument;
            if (request == TIOCMBIS)
                modem = device->modem | modem;
            else if (request == TIOCMBIC)
                modem = device->modem & ~modem;
            snprintf(line, sizeof line, "S %d %d\n", (modem & TIOCM_DTR) != 0,
                     (modem & TIOCM_RTS) != 0);
            if (send_event(device, line) == 0) {
                device->modem = modem;
                return 0;
            }
        }
        break;
    case TIOCSBRK:
    case TIOCCBRK:
        if ((device = bridge_device(fd)) != NULL
            && send_event(device, request == TIOCSBRK ? "B 1\n" : "B 0\n") == 0)
            return 0;
        break;
    }
    /* Not a bridge device, or the bridge did not take the event: libc answers. */
    return libc_ioctl(fd, request, argument);
}

int tcsetattr(int fd, int actions, const struct termios *settings)
{
    static int (*libc_tcsetattr)(int, int, const struct termios *);
    struct device *device;
    struct termios held;
    char line[16];
    tcflag_t frame;
    int data_bits;
    int result;

    if (libc_tcsetattr == NULL)
        libc_tcsetattr = (int (*)(int, int, const struct termios *))dlsym(RTLD_NEXT, "tcsetattr");
    if ((device = bridge_device(fd)) == NULL)
        return libc_tcsetattr(fd, actions, settings);

    /* libc first: the baud rate reaches the pty, where the bridge reads it. A pty
     * holds 8 data bits and no parity whatever is asked. The glibc of Debian and
     * Ubuntu fails the call with EINVAL when that is all the call would change, so
     * libc is asked for the format a pty holds; the tool's own goes to the bridge. */
    held = *settings;
    held.c_cflag = (held.c_cflag & ~(CSIZE | PARENB)) | CS8;
    result = libc_tcsetattr(fd, actions, &held);
    if (result != 0)
        return result;

    frame = settings->c_cflag & FRAME_BITS;
    switch (frame & CSIZE) {
    case CS5: data_bits = 5; break;
    case CS6: data_bits = 6; break;
    case CS7: data_bits = 7; break;
    default: data_bits = 8; break;
    }
    /* Sent on every call: the bridge returns to the profile's format when the tool
     * closes the device, so a format set again after a reopen must reach it again. */
    snprintf(line, sizeof line, "T %d %c %d\n", data_bits,
             !(frame & PARENB) ? 'N' : (frame & PARODD) ? 'O' : 'E', (frame & CSTOPB) ? 2 : 1);
    if (send_event(device, line) == 0) {
        device->frame = frame;
        device->frame_known = 1;
    }
    return 0;
}

int tcgetattr(int fd, struct termios *settings)
{
    static int (*libc_tcgetattr)(int, struct termios *);
    struct device *device;
    int result;

    if (libc_tcgetattr == NULL)
        libc_tcgetattr = (int (*)(int, struct termios *))dlsym(RTLD_NEXT, "tcgetattr");

    result = libc_tcgetattr(fd, settings);
    if (result == 0 && (device = bridge_device(fd)) != NULL && device->frame_known)
        settings->c_cflag = (settings->c_cflag & ~FRAME_BITS) | device->frame;
    return result;
}
