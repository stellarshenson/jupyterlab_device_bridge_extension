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

