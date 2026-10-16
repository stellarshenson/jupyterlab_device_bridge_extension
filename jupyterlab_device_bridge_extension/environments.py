"""The environments in which a device shell can start.

The current environment is the one the command runs in: its PATH, plus the bin directories
of pipx and of uv tools. The other environments are the virtual environment `.venv` in the
start directory of the shell (project) and the conda environments that `conda env list`
reports (global). Such an environment is offered when its bin directory holds a known upload
tool; the caller gives the tool names.

Every lookup command is optional: a command that is missing, that exits with a status other
than 0, whose output cannot be read, or that runs longer than `LOOKUP_S`, skips only its own
source. Finding `.venv` runs no command.
"""

import json
import os
import shutil
import subprocess
from dataclasses import dataclass

# The longest time one lookup command may take.
LOOKUP_S = 5.0
# Where conda is when neither CONDA_EXE nor PATH names it.
DEFAULT_CONDA = "/opt/conda/bin/conda"


@dataclass(frozen=True)
class Environment:
    """One environment a device shell can start in.

    Attributes:
        name: The name to show: the conda name, `.venv`, or `current environment`.
        scope: `current`, `project` (the `.venv` of the start directory) or `global` (conda).
        tools: The known upload tools it holds, in the order of the given names.
        prefix: Its directory; None for the current environment.
        conda: True for a conda environment.
    """

    name: str
    scope: str
    tools: tuple[str, ...]
    prefix: str | None = None
    conda: bool = False


def _output(argv: list[str]) -> str | None:
    """Standard output of a lookup command; None when it is missing, fails or runs over `LOOKUP_S`."""
    environment = {**os.environ, "NO_COLOR": "1"}
    environment.pop("FORCE_COLOR", None)  # uv colours a path that it prints under FORCE_COLOR
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=LOOKUP_S,
                              stdin=subprocess.DEVNULL, env=environment)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        return None
    return done.stdout if done.returncode == 0 else None


def _json(argv: list[str]) -> object:
    """The JSON document a lookup command prints; None when there is none."""
    text = _output(argv)
    try:
        return None if text is None else json.loads(text)
    except ValueError:
        return None


def _conda() -> str:
    """The conda command: CONDA_EXE when it is set, else the one on PATH, else `DEFAULT_CONDA`."""
    return os.environ.get("CONDA_EXE") or shutil.which("conda") or DEFAULT_CONDA


def _tools_in(path: str, names: list[str]) -> tuple[str, ...]:
    """The names of `names` that a directory list in the form of PATH holds as programs."""
    return tuple(name for name in names if shutil.which(name, path=path))


def current(names: list[str]) -> Environment:
    """The current environment, with the tools of PATH and of the pipx and uv tool directories."""
    folders = [os.environ.get("PATH", "")]
    for argv in (["pipx", "environment", "--value", "PIPX_BIN_DIR"], ["uv", "tool", "dir", "--bin"]):
        text = _output(argv)
        if text and text.strip():
            folders.append(text.strip())
    return Environment("current environment", "current", _tools_in(os.pathsep.join(folders), names))


def _same(path: str, variable: str) -> bool:
    """Whether a directory is the one an environment variable names: an environment active now."""
    value = os.environ.get(variable)
    return bool(value) and os.path.realpath(value) == os.path.realpath(path)


def find(start: str, names: list[str]) -> list[Environment]:
    """The environments other than the current one that hold a known upload tool.

    Args:
        start: The start directory of the shell, where `.venv` is looked for.
        names: The names of the known upload tools.

    Returns:
        The project environment first, then the conda environments in the order conda lists them.
    """
    found = []
    venv = os.path.join(start, ".venv")
    tools = _tools_in(os.path.join(venv, "bin"), names)
    if tools and not _same(venv, "VIRTUAL_ENV"):
        found.append(Environment(".venv", "project", tools, venv))
    listed = _json([_conda(), "env", "list", "--json"])
    if isinstance(listed, dict) and isinstance(listed.get("envs"), list):
        details = listed.get("envs_details")
        details = details if isinstance(details, dict) else {}
        for prefix in listed["envs"]:
            if not isinstance(prefix, str) or _same(prefix, "CONDA_PREFIX"):
                continue
            tools = _tools_in(os.path.join(prefix, "bin"), names)
            detail = details.get(prefix)
            name = detail.get("name") if isinstance(detail, dict) else None
            if tools:
                found.append(Environment(name if isinstance(name, str) and name else os.path.basename(prefix),
                                         "global", tools, prefix, conda=True))
    return found


def activation(chosen: Environment, path: str) -> dict[str, str]:
    """The variables that put a shell into an environment.

    Args:
        chosen: The environment.
        path: The PATH of the shell before the change.

    Returns:
        Nothing for the current environment. Else PATH with the bin directory of the environment
        first and, for conda, CONDA_PREFIX, CONDA_DEFAULT_ENV and the variables of the environment
        (`conda env config vars`); for a virtual environment VIRTUAL_ENV.
    """
    if chosen.prefix is None:
        return {}
    variables = {"PATH": os.pathsep.join(filter(None, (os.path.join(chosen.prefix, "bin"), path)))}
    if not chosen.conda:
        return {**variables, "VIRTUAL_ENV": chosen.prefix}
    own = _json([_conda(), "env", "config", "vars", "list", "-p", chosen.prefix, "--json"])
    if not (isinstance(own, dict) and all(isinstance(value, str) for value in own.values())):
        own = {}
    return {**variables, "CONDA_PREFIX": chosen.prefix, "CONDA_DEFAULT_ENV": chosen.name, **own}
