import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  Dialog,
  ICommandPalette,
  InputDialog,
  Notification,
  showDialog
} from '@jupyterlab/apputils';

import { IMainMenu } from '@jupyterlab/mainmenu';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { IStatusBar } from '@jupyterlab/statusbar';

import { Menu, Widget } from '@lumino/widgets';

// Activation needs all three at once: the model attaches the granted devices when the
// page loads, the panel is built for the sidebar and the status item goes into the
// status bar.
/* eslint-disable jupyter/prefer-lazy-imports */
import { DeviceBridgeModel, GrantError } from './model';
import { DeviceBridgePanel, PANEL_ID, requestedDevice } from './panel';
import { DeviceBridgeStatus } from './status';
/* eslint-enable jupyter/prefer-lazy-imports */
import type { IDeviceTable, ISerialDefaults } from './protocol';

const PLUGIN_ID = 'jupyterlab_device_bridge_extension:plugin';
const STATUS_ID = 'jupyterlab_device_bridge_extension:status';
const MENU_ID = 'jp-mainmenu-devices';
const CATEGORY = 'Devices';

const CONNECT_SERIAL = 'device-bridge:connect-serial';
const CONNECT_USB = 'device-bridge:connect-usb';
const OPEN_TERMINAL = 'device-bridge:open-terminal';
const START_RUN = 'device-bridge:start-run';
const SHOW_PANEL = 'device-bridge:show-panel';

/** The description of the arguments of a command that takes none. */
const NO_ARGS = { args: { type: 'object', properties: {} } };

/**
 * The command of jupyterlab_basic_terminal_extension. It takes `{argv}`, starts that
 * list of words in a terminal of the lab with no shell around it, and closes the tab
 * of the terminal when the program ends. This id is the only coupling to that
 * extension, so the plugin asks the command registry for it at each start.
 */
const BASIC_TERMINAL_LAUNCH = 'basic-terminal:launch';

/** The program of every command line that the plugin starts in a terminal. */
const CLI = 'jupyterlab-device';

/**
 * A command line that ends with an error earlier than this many seconds after its
 * start keeps its terminal until the user presses Enter.
 */
const QUICK_FAILURE_S = 5;

/**
 * The bash script that runs a command line in a launched terminal. The words after
 * the script are the command line, so the script has it as `"$0" "$@"`. The tab of
 * the terminal closes when the script ends. So that a refusal of the CLI stays
 * readable, the script waits for one line of input when the command line ended with
 * a status other than 0 at once. It ends with the status of the command line.
 */
const LAUNCH_SCRIPT = [
  '"$0" "$@"',
  'status=$?',
  `if [ "$status" -ne 0 ] && [ "$SECONDS" -lt ${QUICK_FAILURE_S} ]; then`,
  "  printf 'Press Enter to close this terminal. '",
  '  read -r',
  'fi',
  'exit "$status"'
].join('\n');

/** What stands for the path of a serial device in an example line. */
const PATH_PLACEHOLDER = '<path>';

/**
 * The example command lines of the Info dialog, by the name of the tool. Each one is a
 * command line of the README section Working with an AI agent, without
 * `jupyterlab-device run -- ` in front where the README line has it, and with the
 * placeholder where the README has its example path. A Jest test compares them with
 * the README.
 */
const EXAMPLES: Array<[tool: string, line: string]> = [
  [
    'avrdude',
    'avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i'
  ],
  ['stm32flash', 'stm32flash -b 115200 -w firmware.bin -v -g 0x0 <path>'],
  ['esptool', 'esptool --port <path> write-flash 0x0 firmware.bin']
];

/**
 * The option that makes the lab display a notification as a toast, which stays until
 * the user closes it. Without `autoClose` the lab only adds a notification to its list.
 */
const TOAST = { autoClose: false } as const;

/**
 * Tell the user why a grant dialog of the browser gave no device.
 *
 * A dialog the user closed needs no message. A dialog the browser did not open for
 * lack of a user gesture gets a message that names the button to use.
 *
 * @param error What `connectSerial`, `connectUsb` or `grantRequest` of the model rejected with
 */
function reportGrantError(error: unknown): void {
  const reason = error instanceof GrantError ? error.reason : 'failed';
  const text = error instanceof Error ? error.message : String(error);
  if (reason === 'cancelled') {
    return;
  }
  if (reason === 'gesture') {
    Notification.emit(
      'The browser opens its device dialog only after a click. Use a button of the Devices panel (if no sidebar has it: View → Show Devices Panel).',
      'warning',
      TOAST
    );
    return;
  }
  Notification.emit(`No device was attached: ${text}`, 'error', TOAST);
}

/**
 * The body of the Info dialog: the attached devices and the example command lines,
 * with the path of the first attached serial device in them.
 *
 * Hooks for the tests, each one an attribute:
 *
 *   attached device   [data-info-device="<name>"] with [data-field="name"] and, for a
 *                     serial device, [data-field="path"]
 *   example line      [data-example="avrdude|stm32flash|esptool"]
 *   note              [data-field="note"]
 *
 * @param devices The device table of the server
 * @returns A widget for the body of a dialog of the lab
 */
function runInfoBody(devices: IDeviceTable): Widget {
  const serial = devices.serial.filter(record => record.state === 'attached');
  const usb = devices.usb.filter(record => record.state === 'attached');
  const path = serial.length > 0 ? serial[0].path : PATH_PLACEHOLDER;

  const body = new Widget();
  body.addClass('jp-DeviceBridgeInfo');
  const add = (
    tag: 'div' | 'span' | 'code',
    name: string,
    text: string,
    parent: HTMLElement = body.node
  ): HTMLElement => {
    const node = document.createElement(tag);
    node.className = `jp-DeviceBridgeInfo-${name}`;
    node.textContent = text;
    parent.append(node);
    return node;
  };

  add('div', 'title', 'Attached devices');
  for (const record of [...serial, ...usb]) {
    const row = add('div', 'device', '');
    row.dataset.infoDevice = record.name;
    add('span', 'name', record.name, row).dataset.field = 'name';
    // A USB device has no path: a program reaches it through the bridge.
    if ('path' in record) {
      add('code', 'path', record.path, row).dataset.field = 'path';
    }
  }
  if (serial.length + usb.length === 0) {
    add('div', 'text', 'No device is attached.');
  }
  add('div', 'title', 'Example command lines');
  for (const [tool, line] of EXAMPLES) {
    add(
      'code',
      'example',
      line.replace(PATH_PLACEHOLDER, path)
    ).dataset.example = tool;
  }
  add(
    'div',
    'text',
    'Type a line in a device shell. The button Start of the section Device shell and tools opens one. No line was run against a board.'
  ).dataset.field = 'note';
  return body;
}

/**
 * The default serial settings that the settings of the plugin hold. The lab has
 * checked the values against the schema.
 *
 * @param settings The settings of the plugin
 * @returns What a serial port gets when it is added
 */
function serialDefaults(settings: ISettingRegistry.ISettings): ISerialDefaults {
  const value = (key: string): unknown => settings.get(key).composite;
  return {
    baudRate: value('defaultBaudRate'),
    dataBits: value('defaultDataBits'),
    parity: value('defaultParity'),
    stopBits: value('defaultStopBits'),
    onOpen: value('defaultOnOpen')
  } as ISerialDefaults;
}

/**
 * The device bridge in the lab: the commands, the Devices panel, the status bar item,
 * the optional Devices menu, the notifications of device requests and the Info dialog
 * of the runs.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    "Bridge serial (COM) ports and USB devices of the browser's computer into the JupyterLab container, so terminal programs and AI agents can program and read microcontroller boards",
  autoStart: true,
  optional: [
    ICommandPalette,
    IMainMenu,
    IStatusBar,
    ISettingRegistry,
    ILayoutRestorer
  ],
  activate: async (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    mainMenu: IMainMenu | null,
    statusBar: IStatusBar | null,
    settingRegistry: ISettingRegistry | null,
    restorer: ILayoutRestorer | null
  ): Promise<void> => {
    console.log(
      'JupyterLab extension jupyterlab_device_bridge_extension is activated!'
    );
    const { commands, shell, serviceManager } = app;

    // The settings are loaded first, and the lab waits for this activation before it
    // restores its layout. So the panel is in the sidebar before the restore, and the
    // worker has the default serial settings before it claims the ports granted
    // earlier. Without the settings the plugin runs with the defaults of the schema.
    const settings = settingRegistry
      ? await settingRegistry.load(PLUGIN_ID).catch(reason => {
          console.error(
            'Failed to load the settings of jupyterlab_device_bridge_extension.',
            reason
          );
          return null;
        })
      : null;
    const model = new DeviceBridgeModel(
      serviceManager.serverSettings,
      settings ? serialDefaults(settings) : undefined
    );

    // The three handlers below are the only callers of the grant dialogs. Each runs
    // inside a click or a command, because the browser wants a user gesture.
    const connectSerial = (): void => {
      model.connectSerial().catch(reportGrantError);
    };
    const connectUsb = (): void => {
      model.connectUsb().catch(reportGrantError);
    };
    const grantRequest = (id: string): void => {
      model.grantRequest(id).catch(reportGrantError);
    };

    /**
     * Start one command line of the CLI in a terminal of the lab, through the command
     * of the basic terminal extension. No line is typed into a terminal. Where the
     * server offers no terminals, or the lab has no such command, show the command
     * line for the user to run.
     *
     * @param words The words of the command line after the program `jupyterlab-device`
     */
    const runInTerminal = async (...words: string[]): Promise<void> => {
      const line = [CLI, ...words].join(' ');
      if (!serviceManager.terminals.isAvailable()) {
        Notification.emit(
          `This server offers no terminals. Run this command in a shell of the container: ${line}`,
          'info',
          TOAST
        );
        return;
      }
      if (!commands.hasCommand(BASIC_TERMINAL_LAUNCH)) {
        Notification.emit(
          `The lab has no jupyterlab_basic_terminal_extension. Run in a shell of the container: ${line}`,
          'warning',
          TOAST
        );
        return;
      }
      await commands.execute(BASIC_TERMINAL_LAUNCH, {
        argv: ['/bin/bash', '-c', LAUNCH_SCRIPT, CLI, ...words]
      });
    };

    /**
     * Start the serial terminal program of the CLI on one attached serial port, in a
     * terminal of the lab. Without a name it takes the only attached port, or asks
     * which one when several are attached.
     */
    const openTerminal = async (name?: string): Promise<void> => {
      const ports = model.devices.serial
        .filter(record => record.state === 'attached')
        .map(record => record.name);
      if (ports.length === 0) {
        Notification.emit(
          'No serial port is attached. Add a serial port in the Devices panel first (if no sidebar has the panel: View → Show Devices Panel).',
          'warning',
          TOAST
        );
        return;
      }
      let port: string;
      if (name !== undefined) {
        // The name becomes part of a command line, so it must be a name of the table.
        if (!ports.includes(name)) {
          Notification.emit(
            `No attached serial port has the name ${name}.`,
            'warning',
            TOAST
          );
          return;
        }
        port = name;
      } else if (ports.length === 1) {
        port = ports[0];
      } else {
        const choice = await InputDialog.getItem({
          title: 'Serial Terminal',
          label: 'Serial port',
          items: ports,
          editable: false
        });
        // A dialog the user cancelled has no value.
        if (!choice.value) {
          return;
        }
        port = choice.value;
      }
      await runInTerminal('terminal', port);
    };

    /**
     * Start a device shell, `jupyterlab-device shell`, in a terminal of the lab. The
     * server lists that shell as a run.
     */
    const startRun = (): Promise<void> => runInTerminal('shell');

    /** Open the dialog that says how to connect a tool to an attached device. */
    const showRunInfo = (): void => {
      void showDialog({
        title: 'How to connect a tool',
        body: runInfoBody(model.devices),
        buttons: [Dialog.okButton({ label: 'Close' })]
      });
    };

    const panel = new DeviceBridgePanel({
      model,
      connectSerial,
      connectUsb,
      grantRequest,
      openTerminal: name => void openTerminal(name),
      startRun: () => void startRun(),
      showRunInfo
    });

    // The option showPanel: the panel is in the left sidebar only while it is true.
    // `panelShown` is the option as the user sees it. With the settings of the plugin it
    // follows the setting showPanel, and a choice of the user is saved to that setting.
    let panelShown = false;
    // The layout restorer learns the panel when the panel is shown the first time and
    // not before. When the lab restores its layout it puts every widget the restorer
    // knows into the sidebar if the saved layout names it, also while the option is
    // false.
    let restorable = false;
    const applyShowPanel = (show: boolean): void => {
      if (show === panelShown) {
        return;
      }
      panelShown = show;
      if (show) {
        if (restorer && !restorable) {
          restorer.add(panel, PANEL_ID);
          restorable = true;
        }
        shell.add(panel, 'left', { rank: 600 });
      } else {
        // Out of the sidebar. The panel object stays, and so does all it shows: the
        // model, the worker and the attached devices do not depend on the panel.
        panel.parent = null;
      }
      // The mark of the menu item follows the option.
      commands.notifyCommandChanged(SHOW_PANEL);
    };
    /**
     * Set the option as the user chose it: the panel follows at once, then the lab saves
     * the setting. A save that fails leaves the panel as chosen and raises a warning.
     *
     * @returns A promise that ends when the save ended; it never rejects
     */
    const setShowPanel = async (show: boolean): Promise<void> => {
      applyShowPanel(show);
      if (!settings) {
        return;
      }
      try {
        await settings.set('showPanel', show);
      } catch (reason) {
        const text = reason instanceof Error ? reason.message : String(reason);
        Notification.emit(
          `The Devices panel is ${show ? 'shown' : 'hidden'} now, but the lab could not save the setting showPanel: ${text}`,
          'warning',
          TOAST
        );
      }
    };
    /** Put the panel into the sidebar when it is not there, and open it. It does not wait for the save. */
    const openPanel = (): Promise<void> => {
      const saved = panelShown ? Promise.resolve() : setShowPanel(true);
      shell.activateById(PANEL_ID);
      return saved;
    };

    commands.addCommand(CONNECT_SERIAL, {
      label: 'Connect Serial Port',
      caption:
        'Choose a serial port of this computer in the dialog of the browser and attach it',
      describedBy: NO_ARGS,
      execute: connectSerial
    });
    commands.addCommand(CONNECT_USB, {
      label: 'Connect USB Device',
      caption:
        'Choose a USB device of this computer in the dialog of the browser and attach it',
      describedBy: NO_ARGS,
      execute: connectUsb
    });
    commands.addCommand(OPEN_TERMINAL, {
      label: 'Serial Terminal',
      caption:
        'Open a lab terminal with a serial terminal program on an attached serial port',
      describedBy: {
        args: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'The name of an attached serial port, for example tty-2341-0043. Without it the command takes the only attached port, or asks when several are attached.'
            }
          }
        }
      },
      execute: args => openTerminal(args.name as string | undefined)
    });
    commands.addCommand(START_RUN, {
      label: 'Device Shell',
      caption:
        'Open a device shell: a lab terminal in which tools control the lines of the serial ports',
      describedBy: NO_ARGS,
      execute: startRun
    });
    commands.addCommand(SHOW_PANEL, {
      label: 'Show Devices Panel',
      describedBy: NO_ARGS,
      isToggled: () => panelShown,
      execute: () => (panelShown ? setShowPanel(false) : openPanel())
    });
    const commandIds = [
      CONNECT_SERIAL,
      CONNECT_USB,
      OPEN_TERMINAL,
      START_RUN,
      SHOW_PANEL
    ];

    if (palette) {
      for (const command of commandIds) {
        palette.addItem({ command, category: CATEGORY });
      }
    }

    if (statusBar) {
      const status = new DeviceBridgeStatus(model, () => void openPanel());
      statusBar.registerStatusItem(STATUS_ID, {
        item: status,
        align: 'left',
        rank: 100,
        // Above zero, so that the status bar keeps the item in a narrow window: the
        // user must always see that programs have access to hardware.
        priority: 1,
        isActive: () => status.count > 0,
        activeStateChanged: status.countChanged
      });
    }

    // A device request shows in the panel and as a notification with a Grant action,
    // so the user sees it with the panel closed. The notification goes when the
    // request is answered or has expired.
    const notified = new Map<string, string>();
    model.requestsChanged.connect((_, requests) => {
      const pending = new Set(requests.map(request => request.id));
      for (const [id, notification] of notified) {
        if (!pending.has(id)) {
          Notification.dismiss(notification);
          notified.delete(id);
        }
      }
      for (const request of requests) {
        if (notified.has(request.id)) {
          continue;
        }
        const notification = Notification.emit(
          `${request.program} asks for a ${requestedDevice(request)}: ${request.reason}`,
          'info',
          {
            autoClose: false,
            actions: [
              {
                label: 'Grant',
                caption:
                  'Choose the device in the dialog of the browser and attach it',
                displayType: 'accent',
                callback: () => grantRequest(request.id)
              }
            ]
          }
        );
        notified.set(request.id, notification);
      }
    });

    if (settings) {
      // The Devices menu exists only while the setting showMenu is true.
      let menu: Menu | null = null;
      const applyShowMenu = (show: boolean): void => {
        if (show && !menu && mainMenu) {
          menu = new Menu({ commands });
          menu.id = MENU_ID;
          menu.title.label = CATEGORY;
          for (const command of commandIds) {
            menu.addItem({ command });
          }
          mainMenu.addMenu(menu);
        } else if (!show && menu) {
          menu.dispose();
          menu = null;
        }
      };
      const applySettings = (): void => {
        applyShowPanel(settings.get('showPanel').composite === true);
        applyShowMenu(settings.get('showMenu').composite === true);
      };
      applySettings();
      settings.changed.connect(() => {
        applySettings();
        // For the ports added from now on; a port the server knows keeps its values.
        model.setSerialDefaults(serialDefaults(settings));
      });
    }
  }
};

export default plugin;
