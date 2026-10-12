<!-- @import /home/lab/.claude/CLAUDE.md -->
<!-- @import /home/lab/workspace/.claude/CLAUDE.md -->

# Project-Specific Configuration

This file is an overlay. It imports two layers and copies neither:

- **User layer** - `/home/lab/.claude/CLAUDE.md`, applies to every project on this machine
- **Workspace layer** - `/home/lab/workspace/.claude/CLAUDE.md`, applies to everything under `~/workspace`

Both layers apply in full. Rules below extend or strengthen them; where they overlap, the stricter
wording wins. The workspace `/home/lab/workspace/.claude/` directory and the skills the two layers
name carry every standard not restated here.

## Mandatory Bans (Reinforced)

The following workspace rules are STRICTLY ENFORCED for this project:

- **No automatic git tags** - only create tags when user explicitly requests
- **No automatic version changes** - only modify version in package.json/pyproject.toml/etc. when user explicitly requests
- **No automatic publishing** - never run `make publish`, `npm publish`, `twine upload`, or similar without explicit user request
- **No manual package installs if Makefile exists** - use `make install` or equivalent Makefile targets, not direct `pip install`/`uv install`/`npm install`
- **No automatic git commits or pushes** - only when user explicitly requests

## Project Context

JupyterLab 4 extension, `kind: frontend-and-server`, scaffolded from the official copier template
`jupyterlab/extension-template` v4.6.5. It gives programs in the lab container access to a serial
port (COM port) or a USB device plugged into the computer where the browser runs. The container
has no access to the hardware; the browser has it, after the user grants one device in Chrome's
dialog. The first user is an AI agent in the lab terminal that builds firmware, uploads it to a
board and reads the board's serial output.

```
board → Windows driver → Chrome tab (Web Serial, WebUSB) → WebSocket → Jupyter server extension → endpoint in the container → the agent's tools
```

**The brief is the specification**: `docs/brief.md`. It lists the facts tested in this container,
the statements that are from knowledge and not tested, the required behaviour, the constraints,
the tests without hardware and the limits of the first version. Read it before any design or code.

**Reference designs** - two siblings already bridge a browser capability to terminal programs.
Read their README, `docs/`, Python package and `src/` before designing:

- `/home/lab/workspace/private/jupyterlab/jupyterlab_voice_capture_extension` - browser microphone
  to a server-side FIFO (`routes.py`, `sink.py`, `cli.py`)
- `/home/lab/workspace/private/jupyterlab/jupyterlab_passkey_extension` - a local program asks, the
  browser tab acts, the result returns (`relay.py`, `routes.py`, `cli.py`, README section "Working
  with an AI agent")

**The three parts the brief requires**: a frontend plugin (panel, status bar item, Web Serial and
WebUSB, the byte path in a dedicated Web Worker), a server extension (websocket from the tab, one
virtual serial device per attached port, a USB relay, a monitor buffer), and one CLI,
`jupyterlab-device`, with a Python client module, a pyusb backend and a preload shim.

**State**: the three parts are built to `docs/design.md`, the contract between them, and tested
against simulated devices only. No test used a physical board: the criteria that need one
(`ACC-BOARD-98` to `ACC-BOARD-107`, test tag `MANUAL`) are open. Update this section when the
architecture changes.

**Architecture**:

- **Server** (Python, `jupyterlab_device_bridge_extension/`)
  - `__init__.py` - the settings `DeviceBridge.device_dir` and `DeviceBridge.monitor_bytes`, one
    `DeviceManager` per server, handler registration, release of the devices when the server ends
  - `manager.py` - `DeviceManager`: tabs, claims and ownership, device names, commands to the tab
    with `seq` and ack, device requests, the table broadcast; `SerialDevice` joins the profile, the
    pty, the shim socket and the monitor buffer of one port
  - `vserial.py` - `VirtualSerial`: the pty, its symlink in the device directory, tool open and
    close, the holder, the baud rate, the queue to the tool; Linux only
  - `monitor.py` - `MonitorBuffer`, the ring buffer of the bytes a port sent
  - `profiles.py` - the five built-in profiles, the actions, the check of a profile change
  - `usb.py` - the USB record and the plan of one USB operation
  - `shim.py` - the Unix socket of one pty that the preload shim talks to
  - `routes.py` - the WebSocket of the lab tabs (`@ws_authenticated`) and the REST API
    (`@tornado.web.authenticated`), under `jupyterlab-device-bridge-extension/`
- **CLI and client** (Python, same package)
  - `cli.py` - `jupyterlab-device`, the one console script; its `--help` is written for agents
  - `client.py` - `DeviceBridgeClient`, `SerialDevice`, `UsbDevice`, `DeviceBridgeError`; finds the
    server and its token as the passkey extension does; importing it needs the package and with it
    `jupyter_server`
  - `pyusb_backend.py` - `get_backend()` and `install()`; the only module that imports pyusb
  - `shim_build.py`, `shim/devshim.c` - the preload shim: the C source ships in the wheel and is
    compiled on first use into `~/.cache/jupyterlab-device-bridge/`
- **Frontend** (TypeScript, `src/`)
  - `index.ts` - the plugin: four commands, the palette, the Devices menu (setting `showMenu`), the
    notifications of device requests, the command that opens the serial terminal
  - `model.ts` - `DeviceBridgeModel`: starts the worker, keeps what it reports, and is the only
    caller of the grant dialogs `requestPort` and `requestDevice`
  - `worker.ts` - `workerMain(scope)`, one self-contained function started from a Blob URL: the
    WebSocket and every serial port and USB device
  - `protocol.ts` - the types of the messages and the records; no code
  - `panel.ts`, `status.ts`, `icons.ts` - the Devices panel, the status bar item, the icon
  - `request.ts` - the REST helper and the WebSocket URL
- **Serial terminal** - no code of this extension: `jupyterlab-device terminal` becomes pyserial's
  miniterm, and the lab command types that command line into a JupyterLab terminal
- **Schema** (`schema/plugin.json`) - the settings `showPanel` (the Devices panel is in the left sidebar
  only while it is true; default false), `showMenu` and the five default serial settings of a new
  port; the item Show Devices Panel of the View menu
- **Tests** - pytest in `jupyterlab_device_bridge_extension/tests/` (fixtures in `conftest.py`,
  `fake_tab.py` plays the browser tab, `test_readme.py` holds the README to the brief); Jest in
  `src/__tests__/` (`sim.ts` simulates `navigator.serial`, `navigator.usb` and the WebSocket);
  Playwright/Galata in `ui-tests/` (`tests/device-sim.js` simulates both interfaces in the page and
  in the worker; the lab, the server, the CLI and miniterm are real)
- **Agent skill** (`.agents/skills/jupyterlab-device-bridge-extension/SKILL.md`) - tells an agent
  to read `jupyterlab-device --help` first; the wheel installs it under `share/jupyter/agents/skills/`
- **CI/CD** - GitHub Actions plus jupyter-releaser under `.github/workflows/`

**Terms**: a **grant** is the user's permission for one device in Chrome's dialog; **attached**
means the tab holds the device and the server exposes it to container programs; a **profile** is
the serial settings (parity, data bits, stop bits) plus the action on open; the **shim** is the
`LD_PRELOAD` library that passes a tool's DTR, RTS and parity calls to the bridge.

## Build Lifecycle - Makefile Only

The Makefile owns the whole build lifecycle. Never run `pip`, `jlpm`, `yarn`, `npm`,
`python -m build`, `twine`, or any build, publish or clean command directly - those bypass the
project-local `.nodeenv/` toolchain the Makefile pins.

| Target          | Effect                                                                                  |
| --------------- | --------------------------------------------------------------------------------------- |
| `make install`  | build and install the extension (raises the patch version, by design of Makefile 1.42+) |
| `make publish`  | release to npm and PyPI - needs explicit approval every time                            |
| `make clean`    | remove build artefacts                                                                  |
| `make mrproper` | remove all build and virtual-environment artefacts                                      |
| `make build`    | resolve `yarn.lock`, format, build the sdist and the wheel; the version stays           |
| `make test`     | Jest, pytest and the endpoint authentication gate                                       |

**Makefile version check**: the local Makefile declares its version on line 1. Compare it against
`/home/lab/workspace/private/jupyterlab/@utils/jupyterlab-extensions/Makefile` and copy the canonical
file over the local one as soon as a newer version is found. Check at the start of any build work.
Local version at project creation: 1.45, identical to canonical.

**Dependency ranges** follow the jupyterlab-extension skill: floor at the installed and tested
`major.minor`, ceiling at the next major, floors read from the installed packages and never from
the registries. `typescript` keeps its tilde; `resolutions` stay exact.

**The Galata suite has no Makefile target**, so it is the one lifecycle step outside the Makefile:
`jlpm install` and `jlpm playwright install chromium` in `ui-tests/`, then
`JUPYTER_TEST_PORT=<free port> jlpm playwright test`. Port 8888 belongs to this workstation's own
lab. Redirect output to a file instead of `| tee`, which reports tee's exit status.

## Git Rules (Project-Specific)

- The repository was initialised with `git init -b main` and an initial import of every artefact
- **Always commit `package.json`, `package-lock.json` and `yarn.lock` together** - a lockfile left
  behind makes CI fail with YN0028 on an immutable install. Makefile 1.41+ produces no
  `package-lock.json`, so in practice this is `package.json` with `yarn.lock`, and
  `ui-tests/package.json` with `ui-tests/yarn.lock`

## Journal Rules (Project-Specific)

- **APPEND ONLY**: New journal entries MUST be appended at the end of the file, never inserted between existing entries
- Entries maintain strict chronological order by position - the last entry in the file is always the most recent work
- Never reorder, move, or insert entries out of sequence
- The Stellars **journal plugin** is the canonical tool for this file: create via `/journal:create`, append via `/journal:update`, archive via `/journal:archive`. The `journal:journal` skill auto-triggers on any mention of "journal" and runs `journal-tools check` after every write
- Direct edits to `JOURNAL.md` are a last resort - prefer the plugin so modus secundis format, continuous numbering and append-only order are enforced automatically

## Acceptance Criteria and Defects

- Criteria live in `docs/acc-crit*.md` and defects in `docs/defects*.md`, written **only** through
  the project-management plugin (the `pm-tools` CLI), never by a hand edit of either file:
  `/project-management:acc-crit` adds, closes, rejects or relates a criterion,
  `/project-management:defect` files, triages, logs or closes a defect, `/project-management:report`
  gives status and coverage
- **Every feature gets its acceptance criteria before the code**, and every criterion names the test
  that proves it
- **Functional tests under `ui-tests/` are part of every feature**, not an afterthought, and run
  green before a release
- Close a criterion only on evidence - the test that ran and what it showed
- A criterion that needs a physical board carries the test tag `MANUAL` and stays open for the user

## Tests

Three tiers, to the testing strategy of the jupyterlab-extension skill:

- **pytest** under `jupyterlab_device_bridge_extension/tests/` for server code
- **Jest** under `src/__tests__/` for frontend logic
- **Playwright/Galata** under `ui-tests/` for everything visible in the browser, written to that
  skill's `references/galata-testing.md`: the port through one variable (`JUPYTER_TEST_PORT`), no
  snapshot-only assertions, a suite that can fail
- **No hardware** - devices are simulated at the browser interface (`navigator.serial`,
  `navigator.usb`) in Jest and in Galata, and the whole path runs against them

## Command-Line Tools and Their Agent Skill

A command-line tool the extension ships (an entry point under `[project.scripts]` in
`pyproject.toml`) gets the `--help` and the agent skill that the jupyterlab-extension skill's section
"Agent Skill for a Shipped CLI" prescribes.

- **Name** - the skill is named after the extension: `jupyterlab-device-bridge-extension`
- **Location** - `.agents/skills/jupyterlab-device-bridge-extension/SKILL.md` at the repository
  root, and in the wheel through the `shared-data` table of `pyproject.toml`
- **Same commit** - the skill and the `--help` text change in the commit that changes the CLI
- **Never inside the Python package** - the CI link check imports the package for every link in a
  Markdown file inside it, and fails without `jupyter_server`
- **Reference implementation** -
  `/home/lab/workspace/private/jupyterlab/jupyterlab_notifications_extension`

## Scope Control - graphify

- Run `/graphify` once the first source is in place to build `tmp/graphify-out/`
- Run `graphify affected` before editing existing code to learn its callers and dependents; that
  affected set is the change budget, and an edit outside it needs the Star Colonel's word
- Run `graphify update` after every edit
- The graph lives in `tmp/graphify-out/`, not in graphify's default `graphify-out/`: prefix every
  graphify command with `GRAPHIFY_OUT=tmp/graphify-out`, for example
  `GRAPHIFY_OUT=tmp/graphify-out graphify update .`
- `tmp/` is gitignored, so the graph never ships

## Required Skills

| Skill                                   | Use                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `jupyterlab-extension`                  | extension development guidelines, testing strategy, CI/CD, caveats                    |
| `my-browser`                            | browser automation for screenshots and UI verification against the running JupyterLab |
| `project-management:project-management` | acceptance criteria and defects through the `pm-tools` CLI                            |
| `graphify`                              | the codebase graph and the impact analysis that bounds every change                   |
| `journal:journal`                       | the project journal through the `journal-tools` CLI                                   |

## Strengthened Rules

- **A device is opened only after the user's grant** - no code path grants a device without the
  user's click in Chrome's dialog
- **Every server endpoint sits behind Jupyter's authentication** - `@tornado.web.authenticated` on
  HTTP verbs, `@ws_authenticated` on websockets; `.github/scripts/check_auth.py` is the gate and
  `make test` runs it
- **Never state that anything works with hardware** - no test here uses a physical board; a claim
  about a board needs the user's `MANUAL` test behind it
- **No apt installs** - a firmware conda environment (`~/.local/lab-utils/envs/firmware-*.py`) is
  installed only when a test needs its tool
- **Unprivileged container** - the design may not need sudo, a kernel module or a device node
- **Styling through JupyterLab CSS variables only** - no literal colours; follow the Extension
  Design System of the jupyterlab-extension skill
