/**
 * The document of the Device Bridge help tab.
 *
 * The plugin renders this text as Markdown in a tab of the main area when the help
 * button of the Devices panel is clicked. The four headings are the sections of the
 * document; the tests read them in this order.
 */
export const HELP_MARKDOWN = `The device bridge gives programs in the container access to serial ports and USB
devices of the computer where the browser runs. The user grants each device in a
dialog of the browser. No program reaches a device without that grant.

## Options

The settings are in Settings → Settings Editor → Device Bridge. A change takes
effect without a reload.

- Show the Devices panel (\`showPanel\`): puts the panel into the left sidebar. The
  menu item View → Show Devices Panel changes the same setting.
- Show the Devices menu (\`showMenu\`): adds the Devices menu with the commands of the
  extension to the menu bar.
- Default baud rate (\`defaultBaudRate\`), default data bits (\`defaultDataBits\`),
  default parity (\`defaultParity\`), default stop bits (\`defaultStopBits\`) and default
  action when a program opens the port (\`defaultOnOpen\`): the values a serial port
  gets when it is added. A port that is already in the panel keeps its values.

The panel has three sections. The plus icon of the header opens the menu that adds a
serial port or a USB device.

- Serial and USB: one row per device with its kind, name, state, traffic and error. A
  serial row shows its baud rate, config, action on open and holder, with the buttons
  Settings and Terminal. Every row has Attach, Detach and Forget.
- Requests: a program in the container asks for a device; Grant opens the dialog of
  the browser.
- Device shells: Start opens a device shell and Info shows how to connect a tool. A
  row of a run has Copy and Stop.

The footer shows the round trip: the time a message takes from the browser to the
server and back. It reads not connected while the WebSocket is closed.

## Connections

A grant is the user's permission for one device in the dialog of the browser. The
plus icon opens the menu with Connect Serial Port and Connect USB Device, and each
opens that dialog. A program cannot grant a device; it asks with
\`jupyterlab-device request\`, and the panel and a notification show Grant.

- attached means this tab holds the device, and programs in the container reach it
  through its path. detached means no tab holds it: the path opens, but no byte
  reaches the board. held by another tab means another lab tab holds it.
- Attach takes a detached device again with the grant this tab has. Detach releases
  the device without forgetting the grant. Forget drops the grant: the first click
  changes the label to Confirm forget, and the second click forgets the device.
- The status bar item shows the number of attached devices, and the footer shows the
  round trip. A click on the status bar item opens the panel.

## Tools

- Serial terminal: the Terminal button of a serial row, the command Serial Terminal
  and \`jupyterlab-device terminal <name>\` start a full-screen app for a person at a
  terminal. Ctrl+Q or Esc quits. A script reads with \`monitor read\` and writes with
  \`monitor write\`.
- Device shell: the Start button and the command Device Shell start
  \`jupyterlab-device shell\` in a lab terminal. Every tool started in that shell
  passes its DTR, RTS, break and parity calls to the port, without \`run --\`.
- Runs: the section Device shells lists each device shell and each tool started with
  \`run\`: its program, pid, command line and device. Stop ends the program: the first
  click changes the label to Confirm stop, and the second click sends the signal. The
  server ends a program that still runs 3 seconds later by force.

The command \`jupyterlab-device\` runs in a shell of the container; these are the common commands, and \`jupyterlab-device --help\` is the full reference:

- \`list\`: the devices with path, state, holder and settings.
- \`status\`: the server, its lab tabs and the browser interfaces.
- \`monitor read <device>\`: the bytes the port sent, also the bytes that arrived
  before the call; with \`--follow\` it keeps printing until the timeout ends.
- \`monitor write <device> TEXT\`: sends bytes to the port.
- \`settings apply <device> <config>\`: applies a config to a port.
- \`run --device <name> -- CMD\`: starts a tool whose DTR, RTS, break and parity calls
  reach the port.
- \`probe avr\`, \`probe stm32\`, \`probe esp\` and \`probe baud\`: identify the board on a
  port.
- \`shell\`: starts a device shell.
- \`terminal <device>\`: starts the serial terminal.
- \`jupyterlab-device help <command>\` prints the help of a command.

## Connection configs

A config is one settings record: baud rate, data bits, parity, stop bits and the
action when a program opens the port.

The system delivers six read-only configs: Default, Monitor, Arduino upload, Arduino
as ISP, STM32 bootloader and ESP upload. The user can save the current values of a
port under a name; a saved config can be deleted.

The Settings dialog of a serial row has the fields Config, Baud rate, Data bits,
Parity, Stop bits and When a program opens the port. Save sends the chosen config or
the changed fields. Save as... stores the values under a name. Delete config removes
the saved config the port uses; a system config cannot be deleted.

The action when a program opens the port is one of these:

- Do nothing: no action.
- Pulse DTR: resets an Arduino into its bootloader.
- Pulse RTS: pulses the RTS line.
- Enter the ESP bootloader: runs the reset sequence an ESP32 or ESP8266 needs.
- Open at 1200 baud and close: makes some boards come back as another USB device,
  which needs a new grant.
`;
