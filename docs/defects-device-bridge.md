# Defects - jupyterlab_device_bridge_extension

Defects of the device bridge: what fails, how to reproduce it, its root cause and the attempts to fix it. Criteria: `docs/acc-crit-device-bridge.md`. Design: `docs/design.md`.

## Authors

- `@kj` Konrad Jelen

## Grants, authentication and ownership `SEC`

Grants of the browser, which tab owns a device, and who may act on it

- [x] `DEF-SEC-1` **Forget in a second tab revokes the grant of another port** - MEDIUM; two ports with equal vendor and product id, both held by tab 1; tab 1 detaches one, tab 2 forgets it: the browser grant of the other port is revoked too; cause: a refused claim carried no device name; fix: `DeviceManager._claim` sends it; `jupyterlab_device_bridge_extension/manager.py`
  - evidence: galata serial.spec.ts 'ACC-SERIAL-19 forget in a second tab revokes the grant of that port only, when another port has the same ids': red on build 0.6.3 (logs/galata-def-serial-1-red.log), green on build 0.6.4 in the whole suite, 38 passed (logs/galata-suite-1.log); pytest test_manager.py::test_acc_sec_94_a_key_another_tab_holds_is_refused asserts the name
  - root-cause: 2026-10-12T05:22:05Z @kj server answers a refused claim without the device name; the grant of the refused tab keeps name null, so `DeviceBridgeModel._grantsFor` matches grants to a device by vendor id, product id and serial number; both ports match and `forget` revokes both grants
  - repro: galata serial.spec.ts 'ACC-SERIAL-19 forget in a second tab revokes the grant of that port only, when another port has the same ids': fails on build 0.6.3 with grants [] where [the other port] is expected
  - test-tags: FUNCTIONAL, UNIT
  - log: 2026-10-12T05:21:53Z @kj added
  - log: 2026-10-12T05:29:59Z @kj closed: fixed: the server sends the device name with a refused claim (`DeviceManager._claim`), the worker keeps it and the model finds the grant by name
  - log: 2026-10-12T05:30:12Z @kj edited text "two ports with equal vendor and product id, both held by tab 1; tab 1 detaches one, tab 2 forgets it: the browser grant of the other port is revoked too, while tab 1 holds that port; against ACC-SERIAL-19; cause under investigation; `src/model.ts`, `jupyterlab_device_bridge_extension/manager.py`" -> "two ports with equal vendor and product id, both held by tab 1; tab 1 detaches one, tab 2 forgets it: the browser grant of the other port is revoked too; cause: a refused claim carried no device name; fix: `DeviceManager._claim` sends it; `jupyterlab_device_bridge_extension/manager.py`"

## Serial ports `SERIAL`

The byte path between a tool, the virtual serial device and the port in the browser

- [x] `DEF-SERIAL-2` **Port close discards bytes not yet transmitted** - MAJOR; tool writes, then changes the baud rate or closes at settings other than the profile's: the last bytes may never be sent; fix: `await writer.close()` before `port.close()`, so the output is drained; from the Web Serial specification, not tested with a port; `src/worker.ts`
  - evidence: jest worker.spec.ts 'ACC-SERIAL-5 bytes the port has not transmitted yet are transmitted before a baud change closes the port (DEF-SERIAL-2)' and '... before a detach ...': green in make test (logs/repair-1-make-test-1.log, 158 Jest passed), red with writer.close() removed; Galata 39 passed (logs/repair-1-galata-0.log)
  - repro: jest: simulated port that transmits with a delay and drops unsent bytes when its writable is aborted; write 64 bytes, then serial-configure with another baud rate; fewer than 64 bytes arrive
  - test-tags: UNIT
  - root-cause: 2026-10-12T08:38:03Z @kj reproduced in Jest with a simulated port that transmits 30 ms after it accepts a write and discards at close() what it has not transmitted: closePort of src/worker.ts released the writer lock and called port.close() without closing the writer; 0 of 64 bytes written before a detach were transmitted
  - root-cause: 2026-10-12T06:50:09Z @kj closePort releases the writer lock and calls port.close(); by the Web Serial specification close() aborts the writable, which discards output not yet transmitted; closing the writer first drains it
  - log: 2026-10-12T06:50:09Z @kj added
  - log: 2026-10-12T08:38:05Z @kj closed: fixed: closePort closes the writer before port.close(), so the port transmits what it accepted first; proven with a simulated port, not tested with a board
- [x] `DEF-SERIAL-4` **Port that failed to open reads attached and never opens again** - MAJOR; browser cannot open a granted port: `list` prints `attached ... free` with no error, a tool's bytes reach no board, and no `serial-configure` is sent again until the settings change; `cli.py` `cmd_list`, `manager.py` `_configure`
  - evidence: pytest test_cli.py::test_acc_serial_17_list_ends_the_line_of_a_port_in_error_with_the_browsers_reason and test_manager.py::test_acc_serial_17_a_port_that_is_not_open_is_asked_to_open_again: red before the changes, green in make test (311 passed) on build 0.6.8; Galata 40 passed
  - repro: pytest: tab sends serial-state error; list shows attached without the error; a tool opens and writes; no serial-configure, portState stays error
  - test-tags: UNIT
  - root-cause: 2026-10-12T10:37:37Z @kj cmd_list prints state and not error; _configure returns early when target equals settings, whatever port_state is
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: list ends the line of a serial port with its error; serial-configure is sent again while the tab reports the port not open
- [x] `DEF-SERIAL-5` **Links of a killed server lead to another pty** - MEDIUM; server ended by SIGKILL leaves its links and shim sockets; a new server keeps them; the pty number is taken by another terminal and bytes written to the device path arrive there; `manager.py`, `vserial.py`
  - evidence: pytest test_manager.py -k test_acc_sec_97: 5 tests, 4 red before the change, 5 green in make test (311 passed) on build 0.6.8; 12 one-line changes of the new code each turned a test red
  - repro: start a server, attach a port, kill -9 the server, start a second server on the same device directory: the link and the socket are still there
  - test-tags: UNIT
  - root-cause: 2026-10-12T10:37:37Z @kj links and sockets are removed by an atexit hook only, and nothing at server start removes what an earlier server left
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: the server holds a flock on the device directory and removes the symlinks and shim sockets a killed server left; with the lock refused it removes nothing and logs one warning
- [x] `DEF-SERIAL-10` **Start-up cleanup removes symlinks the bridge did not make** - MEDIUM; server start with the directory lock removes every symlink in the device directory; with `DeviceBridge.device_dir` set to a directory that holds the user's own links, those are removed at each start and nothing is logged; `vserial.py` `remove_left`
  - evidence: pytest test_acc_sec_97_a_server_that_starts_keeps_a_symlink_that_leads_to_no_pty_slave: FileNotFoundError on the earlier vserial.py, green on build 0.6.11; pytest 314 passed
  - repro: device directory with a link to a file and a link to a directory; construct DeviceManager on it; both links are gone
  - test-tags: UNIT
  - root-cause: 2026-10-12T12:33:29Z @kj remove_left tests only that an entry is a symlink; the bridge itself makes links to a pty slave only
  - log: 2026-10-12T12:33:29Z @kj added
  - log: 2026-10-12T12:40:00Z @kj closed: fixed: remove_left removes only symlinks whose target is under /dev/pts/
- [x] `DEF-SERIAL-12` **Baud rate above 4294967295 stops the tab's WebSocket** - MINOR; a claim with defaults.baudRate above 4294967295 raises struct.error in the server; the tab gets no claimed answer, the server stops reading its WebSocket, and its ports stay held by that tab after a page load
  - evidence: validate_change refuses a baud rate above 4294967295 and the schema has the maximum; pytest test_profiles.py and test_manager.py case baudRate 4294967296 and galata panel.spec.ts 'DEF-SERIAL-12' pass (build 0.6.16, logs/review-r6-fix-make-test.log and logs/review-r6-fix-galata.log); 3 pytest tests red with the bound removed
  - repro: fake tab: claim a new serial key with defaults baudRate 4294967296, then send ping: no claimed and no pong
  - test-tags: UNIT
  - root-cause: 2026-10-12T16:23:01Z @kj validate_change takes every whole number above 0; vserial packs the speed into a 32-bit field; struct.error is none of the classes _claim and on_message catch, so the read loop of the socket ends
  - log: 2026-10-12T16:23:01Z @kj added
  - log: 2026-10-12T17:04:16Z @kj closed

## Preload shim `SHIM`

The LD_PRELOAD library and the server side that takes its events

- [x] `DEF-SHIM-3` **Shim events handled before the tool's open is seen** - MAJOR; tool under `run` with parity other than the profile's: its DTR and RTS calls reach the port before the reopen with its parity; a tool that opens, sets 8E1 and closes unseen leaves even parity for the next tool; `manager.py` `_shim_event`
  - evidence: pytest test_shim.py::test_acc_shim_33_and_34_pyserial_under_the_shim, test_acc_shim_34_the_format_of_a_tool_that_closed_without_a_write_ends_with_that_tool and test_manager.py::test_acc_shim_34_a_frame_format_line_with_no_tool_on_the_device_changes_nothing: red before the change, green in make test (311 passed) on build 0.6.8
  - repro: pytest: tool under the shim opens, sets 8E1, toggles DTR; tab gets serial-signals before the serial-configure with even parity
  - test-tags: UNIT
  - root-cause: 2026-10-12T10:37:37Z @kj the open is found by the 20 ms poll, shim lines arrive earlier; a T line then stores the frame while pty.held is false, and no close clears it
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: at a line of the shim the bridge looks for the tool's open at once; a T line with no tool on the device changes nothing
- [x] `DEF-SHIM-18` **Stop does not end an interactive shell or its tool** - MAJOR; Stop of a device shell: bash stays listed 3 s until SIGKILL; fish ends at once but its foreground tool keeps running, and a fish stopped under 5 s after Start leaves the prompt Press Enter unable to take Enter
  - evidence: stop_run sends SIGHUP; pytest test_acc_shim_157_stop_ends_an_interactive_shell_together_with_its_foreground_tool[bash] and [fish] passed in 456 passed (logs/review2-r1-make-test.log); probe tmp/review/sig_matrix.py: shell and tool gone within 0.05 s
  - related: ACC-SHIM-130
  - repro: start a device shell with bash, then with fish and a foreground tool; press Stop; measure the shell and the tool (probe sig_matrix.py: bash gone after 3.02 s by SIGKILL; fish gone after 0.05 s, tool alive)
  - test-tags: UNIT, FUNCTIONAL
  - root-cause: 2026-10-13T11:42:14Z @kj stop_run sends SIGTERM to the process id of the run; an interactive bash ignores SIGTERM, and fish ends on SIGTERM without ending its foreground job and without restoring the terminal modes; both end with their jobs on SIGHUP
  - log: 2026-10-13T11:42:14Z @kj added
  - log: 2026-10-13T13:22:17Z @kj closed

## Panel, commands and menu `PANEL`

What the user sees and clicks in the lab

- [x] `DEF-PANEL-6` **Baud field steps by 1 and sends each step** - MINOR; arrow keys or the mouse wheel on the focused baud field change 115200 to 115201 and the panel sends it: the port is reopened at that rate; `src/panel.ts` `profileEditor`
  - evidence: jest panel.spec.ts 'ACC-PROF-23 the baud rate field is a text field with the input mode numeric' and Galata panel.spec.ts 'ACC-PROF-23 an arrow key in the baud rate field of the panel changes no baud rate': red before the change (Galata on build 0.6.7: value 115201), green on build 0.6.8
  - repro: galata: open Profile settings, focus the baud field, press ArrowUp; the record's overrides hold baudRate 115201
  - test-tags: UNIT, FUNCTIONAL
  - root-cause: 2026-10-12T10:37:37Z @kj the field is input type=number, whose step is 1, and every change event is sent to the server
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: the baud rate field of the profile editor is a text field with the input mode numeric
- [x] `DEF-PANEL-11` **Six notifications raise no toast** - MEDIUM; six Notification.emit calls (five in src/index.ts, one in src/panel.ts) pass no autoClose; JupyterLab 4.6.4 then lists the notification and displays no toast; the user sees the count of the status bar item rise and no text
  - evidence: all 8 Notification.emit calls pass autoClose false; jest afterEach check and galata toast tests in terminal.spec.ts and panel.spec.ts pass (build 0.6.16, logs/review-r6-fix-make-test.log and logs/review-r6-fix-galata.log); toast tests failed on build 0.6.14 (logs/review-r5-repro-toast.log); jest red with the option removed at each site
  - repro: run command device-bridge:open-terminal with no attached port: the notification count of the status bar is 1 and no .Toastify__toast appears
  - test-tags: UNIT, FUNCTIONAL
  - root-cause: 2026-10-12T16:16:46Z @kj NotificationManager.notify sets autoClose 0 when the caller gives none, and the lab's toast plugin skips a notification with autoClose at or below 0; Jest replaces Notification.emit, so no test saw what the lab displays
  - log: 2026-10-12T16:16:46Z @kj added
  - log: 2026-10-12T17:04:16Z @kj closed
- [x] `DEF-PANEL-14` **Title of the devices section is cut** - MINOR; at the width the lab gives the left sidebar, 250 px, the title of the devices section of the panel, Serial ports and USB devices, ends with an ellipsis; src/panel.ts
  - evidence: title is now Serial and USB devices, 22 characters; Galata on build 0.6.24 (logs/launch-galata-1.log, 70 pass): the test DEF-PANEL-14 finds no section title cut at 250 px; with the old 28-character title it failed, 215 px needed, 210 px there
  - repro: open the Devices panel in a new lab: the header reads SERIAL PORTS AND USB DEV... (1)
  - test-tags: FUNCTIONAL
  - root-cause: 2026-10-13T08:27:29Z @kj the title has 28 characters, and the header style (uppercase, 1 px letter spacing) fits about 24 at 250 px
  - log: 2026-10-13T08:27:29Z @kj added
  - log: 2026-10-13T09:42:07Z @kj closed
- [x] `DEF-PANEL-15` **Start fails where the terminal gives no SHELL** - MAJOR; Start types jupyterlab-device run -- "$SHELL"; where the server environment has no SHELL, fish expands it to an empty word and no shell starts; bash starts the shell but the CLI prints no banner
  - evidence: Start runs jupyterlab-device shell, which takes the shell command from the server; Galata on build 0.6.24 (logs/launch-galata-1.log, 70 pass) with SHELL removed from the test server: the test DEF-PANEL-15 passes; seen once with launch-shell.sh: fish started, banner shown, LD_PRELOAD set
  - test-tags: UNIT, FUNCTIONAL
  - related: ACC-CLI-144, ACC-PANEL-147 - the shell subcommand and its launch replace the typed line
  - repro: in a lab whose terminals run fish and whose server has no SHELL: press Start; or env -u SHELL fish -c with that line
  - root-cause: 2026-10-13T08:43:05Z @kj the typed line reads the variable SHELL of the terminal shell; fish does not set it, bash does not export its own value; the test servers inherit SHELL=/bin/bash, so no test saw it
  - log: 2026-10-13T08:43:05Z @kj added
  - log: 2026-10-13T08:43:29Z @kj edited test-tags added "UNIT, FUNCTIONAL"
  - log: 2026-10-13T09:42:07Z @kj closed
- [ ] `DEF-PANEL-19` **Refused launch by the terminal server shows [object Object]** - MINOR; when the server of the terminal extension refuses a launch, for example because the folder of the file browser no longer exists, the notification reads The terminal did not start: [object Object]; the user learns that the launch failed, not why
  - related: ACC-PANEL-161
  - repro: node: build ServerConnection.ResponseError with the body {error: invalid_cwd} as the terminal extension does, run the expression of runInTerminal; output: The terminal did not start: [object Object]
  - test-tags: UNIT
  - root-cause: 2026-10-13T13:40:09Z @kj jupyterlab_basic_terminal_extension 1.0.7 src/request.ts:47 throws ResponseError(response, data.message || data); its server bodies hold error and no message, so the body object becomes the message and the text is lost before this plugin gets the rejection
  - log: 2026-10-13T13:40:09Z @kj added

## Command line and agent documents `CLI`

The jupyterlab-device command, its help texts, the README and the agent skill

- [x] `DEF-CLI-7` **USB read without data tells the agent to check the lab tab** - MINOR; `usb transfer` on an IN endpoint with no data ends with the hint "check that the lab tab is open, then run the command again"; the tab is open in that case; `cli.py` `HINTS[504]`
  - evidence: pytest test_cli.py::test_acc_cli_85_the_timeout_of_a_usb_command_ends_the_wait and test_acc_cli_85_a_usb_failure_is_one_line_on_stderr assert the new text: red with the old hint, green in make test (311 passed) on build 0.6.8
  - repro: pytest test_cli.py: usb transfer in with --timeout 200 on a silent endpoint; stderr ends with the lab tab hint
  - test-tags: UNIT
  - root-cause: 2026-10-12T10:37:37Z @kj one hint text serves status 504 for two causes: a tab that did not answer and a device that sent nothing
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: the hint of status 504 names both causes, a lab tab that did not answer and a device that sent no data
- [x] `DEF-CLI-8` **Client documented as standard library only** - MINOR; `client.py` and README say the Python client uses the standard library only; importing the package needs jupyter_server, so a program in another Python environment gets ModuleNotFoundError; `client.py:14`, `README.md`
  - evidence: read client.py and the README section Python client on build 0.6.8; the import with traitlets, tornado and jupyter_server blocked still fails at traitlets, as the README now says; test_readme.py and test_agent_skill.py green in make test (311 passed)
  - repro: python with traitlets, tornado and jupyter_server blocked: import jupyterlab_device_bridge_extension.client fails
  - test-tags: MANUAL
  - root-cause: 2026-10-12T10:37:37Z @kj the package __init__ imports the server extension, and the two texts were written before that was checked
  - log: 2026-10-12T10:37:37Z @kj added
  - log: 2026-10-12T11:24:36Z @kj closed: fixed: client.py and the README no longer say standard library only; the README says that importing the package needs jupyter_server
- [x] `DEF-CLI-9` **Agent texts name no step that clears a port error** - MINOR; `list --help`, the agent skill and README say that with `error:` no byte reaches the board, and name no retry; the port opens again at a profile set or a tool open, so an agent that obeys never uploads; `cli.py`, `SKILL.md`, `README.md`
  - evidence: pytest test_acc_serial_17_a_profile_set_asks_the_browser_to_open_a_port_in_error_again green on build 0.6.11; pytest 314, Jest 159, Galata 41 passed
  - repro: port in state error: list shows error: three times with 0 serial-configure; profile <device> monitor sends 1 and list shows no error:
  - test-tags: UNIT
  - root-cause: 2026-10-12T12:33:29Z @kj the three sentences were written for the list suffix before the reopen of a port that is not open made them conditional
  - log: 2026-10-12T12:33:29Z @kj added
  - log: 2026-10-12T12:40:00Z @kj closed: fixed: list help, agent skill and README name the profile set as the retry and no longer say that no byte reaches the board
- [x] `DEF-CLI-13` **run with an empty tool name ends with a traceback** - MINOR; jupyterlab-device run with an empty word as the tool ends with a ValueError traceback of os.execvpe and exit status 1; docs/design.md says a tool that cannot be started gives one message and exit status 127; cli.py cmd_run
  - evidence: test_def_cli_13_run_with_an_empty_tool_name_says_so_and_exits_127 failed with status 1 before the fix and passes after it; cmd_run now catches ValueError beside OSError; make test on build 0.6.21 (logs/runs-make-test.log): 398 pytest tests pass, 1 skipped
  - repro: jupyterlab-device run -- "" in a lab terminal: traceback, exit status 1
  - test-tags: UNIT
  - root-cause: 2026-10-12T20:45:46Z @kj cmd_run catches only OSError around os.execvpe, and an empty first word raises ValueError
  - log: 2026-10-12T20:45:46Z @kj added
  - log: 2026-10-12T20:49:02Z @kj closed

## Continuous integration `CI`

GitHub Actions workflows, and tests that fail only on a runner

- [x] `DEF-CI-16` **Stopped-server test times out on a runner** - MEDIUM; the pytest test of ACC-SERIAL-3 waits 30 s for its Jupyter server to end after SIGTERM; on a GitHub runner the server did not end in that time, once, and the Build workflow of commit ec53401 failed
  - evidence: GitHub Actions run 38382480138 (Build) of commit 1ece3d6: job build success, pytest step passed with JUPYTER_NO_CONFIG=1 in the test server; local: server ended 0.19 s after SIGTERM against 40.67 s with a 40 s stand-in julia
  - repro: put a program julia that sleeps 40 s on PATH and run the test: the server ends 40 s after SIGTERM
  - test-tags: UNIT
  - root-cause: 2026-10-13T10:12:16Z @kj the test server loaded every extension of the environment; jupyter_lsp looks for language servers in a thread at start, with julia and Rscript calls that have no timeout, and Python ends only after that thread
  - log: 2026-10-13T10:12:16Z @kj added
  - log: 2026-10-13T10:30:23Z @kj closed
- [x] `DEF-CI-17` **Release check fails at the trial upload** - MEDIUM; the Check Release workflow of commit ec53401 failed in the step publish-assets: the trial upload of the wheel to the pypiserver inside the runner was answered with 400 Bad Request
  - evidence: GitHub Actions run 38382480038 (Check Release) of commit 1ece3d6: success with steps_to_skip publish-assets; local: pypiserver 2.3.2 refused the 0.6.24 wheel with MultipartError Memory limit reached
  - repro: start pypiserver 2.3.2 on localhost and upload the wheel with twine: MultipartError: Memory limit reached
  - test-tags: CI
  - root-cause: 2026-10-13T10:12:16Z @kj pypiserver keeps at most 102400 bytes of one upload in memory; the README is the long description of the wheel, 48875 characters; with the wheel of 0.6.24 the largest description that passes has 46516
  - log: 2026-10-13T10:12:16Z @kj added
  - log: 2026-10-13T10:30:23Z @kj closed

