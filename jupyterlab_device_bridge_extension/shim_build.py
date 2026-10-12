"""Builds the preload shim on first use.

The wheel carries the C source and stays pure Python. `build()` compiles it with
the system C compiler into `~/.cache/jupyterlab-device-bridge/` and returns that
file on every later call. The file name carries a hash of the source, so a new
version of the package builds its own library.
"""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

SOURCE = Path(__file__).parent / "shim" / "devshim.c"
COMPILERS = ("cc", "gcc")
NO_SHIM_NEEDED = (
    "set a profile with `jupyterlab-device profile <device> <id>` instead: "
    "a profile needs no shim"
)


class ShimBuildError(Exception):
    """The shim library could not be built; the message names the way without a shim."""


def build() -> Path:
    """Return the path of the shim library, compiling it when the cache has none.

    Raises:
        ShimBuildError: No C compiler is installed, or the compiler failed.
    """
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()[:16]
    library = Path.home() / ".cache" / "jupyterlab-device-bridge" / f"devshim-{digest}.so"
    if library.exists():
        return library

    compiler = next(filter(None, map(shutil.which, COMPILERS)), None)
    if compiler is None:
        raise ShimBuildError(
            f"no C compiler ({' or '.join(COMPILERS)}) is installed, so the preload shim "
            f"cannot be built - {NO_SHIM_NEEDED}"
        )
    library.parent.mkdir(parents=True, exist_ok=True)
    # Compiled beside the target and renamed, so a second process that starts during
    # the build never loads a half-written library.
    partial = library.with_name(f"{library.name}.{os.getpid()}")
    result = subprocess.run(
        [compiler, "-shared", "-fPIC", "-O2", "-o", str(partial), str(SOURCE), "-ldl"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise ShimBuildError(
            f"{compiler} could not build the preload shim: {result.stderr.strip()} - {NO_SHIM_NEEDED}"
        )
    os.replace(partial, library)
    return library
