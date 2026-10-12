/**
 * The plugin against the real model, the real worker function, the real panel,
 * simulated devices and a simulated server.
 *
 * The lab is a small stand-in: a real command registry, a shell that records, and the
 * optional services as recorders. The lab packages that Jest cannot load are replaced:
 * the notifications and the input dialog by recorders, the icon by its SVG text.
 */

import { InputDialog, Notification } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';

import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Menu, Panel, Widget } from '@lumino/widgets';

import plugin from '../index';
import { DeviceBridgePanel } from '../panel';
import type { IDeviceRequest, ISerialDefaults } from '../protocol';
import { DeviceBridgeStatus } from '../status';
import { createWorker, workerMain } from '../worker';
import {
  SimScope,
  SimSerial,
  SimSerialPort,
  SimServer,
  SimUsb,
  SimUsbDevice
} from './sim';

jest.mock('@jupyterlab/application', () => ({
  ILayoutRestorer: 'ILayoutRestorer'
}));
jest.mock('@jupyterlab/apputils', () => ({
  ICommandPalette: 'ICommandPalette',
  InputDialog: { getItem: jest.fn() },
  Notification: { emit: jest.fn(), dismiss: jest.fn() }
}));
jest.mock('@jupyterlab/mainmenu', () => ({ IMainMenu: 'IMainMenu' }));
jest.mock('@jupyterlab/settingregistry', () => ({
  ISettingRegistry: 'ISettingRegistry'
}));
jest.mock('@jupyterlab/statusbar', () => ({ IStatusBar: 'IStatusBar' }));
jest.mock('@jupyterlab/ui-components', () => ({
  LabIcon: class {
    constructor(readonly options: { name: string; svgstr: string }) {}

    element(props: { container: HTMLElement }): HTMLElement {
      props.container.innerHTML = this.options.svgstr;
      return props.container;
    }
  }
}));
jest.mock('../worker', () => ({
  ...jest.requireActual('../worker'),
  createWorker: jest.fn()
}));

const CONNECT_SERIAL = 'device-bridge:connect-serial';
const CONNECT_USB = 'device-bridge:connect-usb';
const OPEN_TERMINAL = 'device-bridge:open-terminal';
const SHOW_PANEL = 'device-bridge:show-panel';
const NEW_LAB_TERMINAL = 'terminal:create-new';
/** How a text of the lab says where the Devices panel is; the panel is hidden by default. */
const VIEW_ITEM = 'View → Show Devices Panel';
const PANEL_ID = 'jupyterlab-device-bridge-panel';

const UNO = { usbVendorId: 0x2341, usbProductId: 0x0043 };
const UNO_KEY = 's:2341:0043:0';
const UNO_NAME = 'tty-2341-0043';
const NANO = { usbVendorId: 0x1a86, usbProductId: 0x7523 };
const NANO_NAME = 'tty-1a86-7523';
const PROBE_NAME = 'usb-0d28-0204';
const PROBE_REQUEST: IDeviceRequest = {
  id: 'request-1',
  kind: 'usb',
  vendorId: 0x0d28,
  productId: 0x0204,
  reason: 'flash the board',
  program: 'pyocd'
};
const PORT_REQUEST: IDeviceRequest = {
  id: 'request-2',
  kind: 'serial',
  reason: 'read the log',
  program: 'agent'
};
const NO_GESTURE = new DOMException(
  'Must be handling a user gesture to show a permission request.',
  'SecurityError'
);

const emit = Notification.emit as jest.Mock;
const dismiss = Notification.dismiss as jest.Mock;
const getItem = InputDialog.getItem as jest.Mock;

/** The session of a lab terminal, as far as the plugin uses it. */
interface ISession {
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  connectionStatusChanged: Signal<ISession, string>;
  send: jest.Mock;
}

/**
 * The settings of the plugin as the schema defines them: every setting with its
 * default value. The file is the one the lab reads.
 */
const SCHEMA_DEFAULTS: Record<string, unknown> = {};
for (const [name, property] of Object.entries(
  (
    jest.requireActual('../../schema/plugin.json') as {
      properties: Record<string, { default: unknown }>;
    }
  ).properties
)) {
  SCHEMA_DEFAULTS[name] = property.default;
}

/** The default serial settings of the schema, as the worker sends them with a claim. */
const MONITOR_DEFAULTS: ISerialDefaults = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  onOpen: 'none'
};

/** The reason a lab gives when it cannot save a setting. */
const SAVE_REFUSED = 'Permission denied';

/** The warning the plugin raises when the lab could not save the option showPanel. */
const notSaved = (state: 'shown' | 'hidden'): [string, string] => [
  `The Devices panel is ${state} now, but the lab could not save the setting showPanel: ${SAVE_REFUSED}`,
  'warning'
];

/** The settings of the plugin, with what the plugin uses of a settings object of the lab. */
interface ISettings {
  composite: Record<string, unknown>;
  changed: Signal<ISettings, void>;
  get(key: string): { composite: unknown };
  /** Saves one setting and then says that the settings changed, as the lab does. */
  set: jest.Mock<Promise<void>, [key: string, value: unknown]>;
}

interface ILab {
  server: SimServer;
  serial: SimSerial;
  usb: SimUsb;
  commands: CommandRegistry;
  shell: { add: jest.Mock; activateById: jest.Mock };
  /** Stands for the left sidebar of the lab: `shell.add` puts a widget into it. */
  sidebar: Panel;
  palette: { addItem: jest.Mock };
  mainMenu: { addMenu: jest.Mock };
  statusBar: { registerStatusItem: jest.Mock };
  restorer: { add: jest.Mock };
  settings: ISettings;
  /** The one panel of the plugin: the first widget it added to the shell. */
  readonly panel: DeviceBridgePanel;
  /** Whether the panel was in the sidebar at the moment the activation of the plugin ended. */
  shownWhenActivated: boolean;
  /** The command of the lab that opens a terminal; it gives a terminal with `session`. */
  newTerminal: jest.Mock;
  session: ISession;
  /** Change one setting as the Settings Editor of the lab does. */
  setSetting(key: string, value: unknown): void;
  /** Change the setting `showMenu` as the Settings Editor of the lab does. */
  setShowMenu(show: boolean): void;
}

interface ILabOptions {
  ports?: SimSerialPort[];
  devices?: SimUsbDevice[];
  /** False: the browser has neither device interface, as on plain http. */
  interfaces?: boolean;
  /** False: the server offers no terminals. */
  terminals?: boolean;
  /** False: the lab has none of the optional services. */
  services?: boolean;
  /** True: the setting registry fails to load the settings of the plugin. */
  loadFails?: boolean;
  /** True: the lab cannot save a setting; `settings.set` rejects with the reason `SAVE_REFUSED`. */
  saveFails?: boolean;
  /**
   * The settings the user changed; every other setting has the default of the schema.
   * When omitted the user set showPanel to true: most tests read the panel, which the
   * default settings keep out of the sidebar. `{}` is a lab with the default settings.
   */
  settings?: Record<string, unknown>;
}

/** Let every promise settle and advance the fake time by `ms`. */
const tick = (ms = 0): Promise<void> => jest.advanceTimersByTimeAsync(ms);

function setInterface(name: 'serial' | 'usb', value?: object): void {
  delete (navigator as unknown as Record<string, unknown>)[name];
  if (value) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

/** A lab with the plugin activated, after the server answered. */
async function lab(options: ILabOptions = {}): Promise<ILab> {
  const server = new SimServer();
  const serial = new SimSerial(...(options.ports || []));
  const usb = new SimUsb(...(options.devices || []));
  const interfaces = options.interfaces !== false;
  const scope = interfaces
    ? new SimScope(server, serial, usb)
    : new SimScope(server);
  setInterface('serial', interfaces ? serial : undefined);
  setInterface('usb', interfaces ? usb : undefined);
  (createWorker as jest.Mock).mockImplementation(() => {
    workerMain(scope);
    return scope.page;
  });

  const session = {
    connectionStatus: 'connected',
    send: jest.fn()
  } as unknown as ISession;
  session.connectionStatusChanged = new Signal<ISession, string>(session);
  const newTerminal = jest.fn(async () => ({ content: { session } }));
  const commands = new CommandRegistry();
  commands.addCommand(NEW_LAB_TERMINAL, { execute: newTerminal });

  const settings = {
    composite: {
      ...SCHEMA_DEFAULTS,
      ...(options.settings ?? { showPanel: true })
    },
    get: (key: string) => ({ composite: settings.composite[key] })
  } as ISettings;
  settings.changed = new Signal<ISettings, void>(settings);
  const setSetting = (key: string, value: unknown): void => {
    settings.composite[key] = value;
    settings.changed.emit();
  };
  settings.set = jest.fn(async (key: string, value: unknown) => {
    // The lab saves the setting on the server before it says that it changed.
    await Promise.resolve();
    if (options.saveFails) {
      throw new Error(SAVE_REFUSED);
    }
    setSetting(key, value);
  });
  const load = options.loadFails
    ? jest.fn(async () => Promise.reject(new Error('The schema is missing.')))
    : jest.fn(async () => settings);

  const sidebar = new Panel();
  Widget.attach(sidebar, document.body);
  const shell = {
    add: jest.fn((widget: Widget) => sidebar.addWidget(widget)),
    activateById: jest.fn()
  };
  const palette = { addItem: jest.fn() };
  const mainMenu = { addMenu: jest.fn() };
  const statusBar = { registerStatusItem: jest.fn() };
  const restorer = { add: jest.fn() };
  const app = {
    commands,
    shell,
    serviceManager: {
      serverSettings: ServerConnection.makeSettings({
        baseUrl: 'http://lab.test/',
        wsUrl: 'ws://lab.test/'
      }),
      terminals: { isAvailable: () => options.terminals !== false }
    }
  };
  const services =
    options.services === false
      ? [null, null, null, null, null]
      : [palette, mainMenu, statusBar, { load }, restorer];
  await plugin.activate(app as any, ...services);
  const shownWhenActivated = sidebar.widgets.length === 1;

  await tick();
  return {
    server,
    serial,
    usb,
    commands,
    shell,
    sidebar,
    palette,
    mainMenu,
    statusBar,
    restorer,
    settings,
    get panel(): DeviceBridgePanel {
      if (shell.add.mock.calls.length === 0) {
        throw new Error('The plugin has not put its panel into the sidebar.');
      }
      return shell.add.mock.calls[0][0] as DeviceBridgePanel;
    },
    shownWhenActivated,
    newTerminal,
    session,
    setSetting,
    setShowMenu: (show: boolean): void => setSetting('showMenu', show)
  };
}

/** Make the server list device requests as pending and tell the tab. */
async function request(
  all: ILab,
  ...requests: IDeviceRequest[]
): Promise<void> {
  all.server.pending.push(...requests);
  all.server.push();
  await tick();
}

const button = (all: ILab, selector: string): HTMLButtonElement =>
  all.panel.node.querySelector<HTMLButtonElement>(selector)!;

// A widget is never given to `expect`: Jest cannot print a widget, and a failed
// comparison of one ends the test run. The three helpers below give plain values.

/** Whether the panel is in the sidebar now. */
const inSidebar = (all: ILab): boolean =>
  all.sidebar.widgets.length === 1 && all.sidebar.widgets[0] === all.panel;

/** Every `shell.add` call: whether its widget is the Devices panel, then its area and its options. */
const shellAdds = (all: ILab): unknown[][] =>
  all.shell.add.mock.calls.map(([widget, area, options]) => [
    widget instanceof DeviceBridgePanel && widget === all.panel,
    area,
    options
  ]);

/** Every `restorer.add` call: whether its widget is the Devices panel, then the name. */
const restorerAdds = (all: ILab): unknown[][] =>
  all.restorer.add.mock.calls.map(([widget, name]) => [
    widget === all.panel,
    name
  ]);

/** The text and the type of every notification the lab raised, in order. */
const notifications = (): Array<[text: string, type: string]> =>
  emit.mock.calls.map(([text, type]) => [text, type]);

/** Click the action of the notification with this number, as the user does in the toast. */
function clickAction(index: number): void {
  emit.mock.calls[index][2].actions[0].callback(new MouseEvent('click'));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  let count = 0;
  emit.mockReset().mockImplementation(() => `notification-${++count}`);
  dismiss.mockReset();
  getItem.mockReset();
});

afterEach(() => {
  // DEF-PANEL-11: the lab displays a toast only for a notification with `autoClose`;
  // every notification of the plugin stays until the user closes it.
  for (const [text, , options] of emit.mock.calls) {
    expect([text, options?.autoClose]).toEqual([text, false]);
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
  setInterface('serial');
  setInterface('usb');
  document.body.replaceChildren();
});

describe('plugin: commands, palette and panel', () => {
  it('ACC-PANEL-67 the plugin registers its four commands, lists them in the palette under Devices and, with showPanel true, adds the panel to the left sidebar', async () => {
    const all = await lab({ settings: { showPanel: true } });
    const ids = [CONNECT_SERIAL, CONNECT_USB, OPEN_TERMINAL, SHOW_PANEL];

    expect(plugin.id).toBe('jupyterlab_device_bridge_extension:plugin');
    expect(plugin.autoStart).toBe(true);
    expect(plugin.optional).toEqual([
      'ICommandPalette',
      'IMainMenu',
      'IStatusBar',
      'ISettingRegistry',
      'ILayoutRestorer'
    ]);
    expect(console.log).toHaveBeenCalledWith(
      'JupyterLab extension jupyterlab_device_bridge_extension is activated!'
    );
    expect(ids.map(id => all.commands.hasCommand(id))).toEqual([
      true,
      true,
      true,
      true
    ]);
    expect(ids.map(id => all.commands.label(id))).toEqual([
      'Connect Serial Port',
      'Connect USB Device',
      'Serial Terminal',
      'Show Devices Panel'
    ]);
    expect(all.palette.addItem.mock.calls).toEqual(
      ids.map(command => [{ command, category: 'Devices' }])
    );
    expect(all.panel).toBeInstanceOf(DeviceBridgePanel);
    expect(all.panel.id).toBe(PANEL_ID);
    expect(shellAdds(all)).toEqual([[true, 'left', { rank: 600 }]]);
    expect(restorerAdds(all)).toEqual([[true, PANEL_ID]]);
  });

  it('ACC-PANEL-67 the command show-panel puts the hidden panel into the left sidebar and opens it', async () => {
    const all = await lab({ settings: {} });

    await all.commands.execute(SHOW_PANEL);

    expect(shellAdds(all)).toEqual([[true, 'left', { rank: 600 }]]);
    expect(inSidebar(all)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);
  });

  it('ACC-PANEL-67 without the optional services of the lab the plugin activates and its commands run', async () => {
    const all = await lab({
      services: false,
      ports: [new SimSerialPort(UNO)]
    });
    all.usb.dialog = new SimUsbDevice();

    await all.commands.execute(CONNECT_USB);
    await all.commands.execute(SHOW_PANEL);
    await all.commands.execute(OPEN_TERMINAL);
    await tick();

    const rows = all.panel.node.querySelectorAll<HTMLElement>('[data-device]');
    expect(Array.from(rows, row => row.dataset.device)).toEqual([
      UNO_NAME,
      PROBE_NAME
    ]);
    expect(all.shell.activateById).toHaveBeenCalledWith(PANEL_ID);
    expect(all.newTerminal).toHaveBeenCalledTimes(1);
    expect(all.palette.addItem).not.toHaveBeenCalled();
    expect(all.mainMenu.addMenu).not.toHaveBeenCalled();
    expect(all.statusBar.registerStatusItem).not.toHaveBeenCalled();
    expect(all.restorer.add).not.toHaveBeenCalled();
  });

  it('ACC-SERIAL-1 the commands connect-serial and connect-usb open the dialog of the browser and the picked device is attached', async () => {
    const all = await lab();
    all.serial.dialog = new SimSerialPort(UNO);
    all.usb.dialog = new SimUsbDevice();

    await all.commands.execute(CONNECT_SERIAL);
    await all.commands.execute(CONNECT_USB);
    await tick();

    expect(all.serial.dialogs).toEqual([null]);
    expect(all.usb.dialogs).toEqual([{ filters: [] }]);
    const rows = all.panel.node.querySelectorAll<HTMLElement>('[data-device]');
    expect(Array.from(rows, row => row.dataset.state)).toEqual([
      'attached',
      'attached'
    ]);
    expect(notifications()).toEqual([]);
  });
});

describe('plugin: a grant dialog that gives no device', () => {
  it('ACC-PANEL-72 a port dialog the browser refuses for lack of a user gesture raises a notification that says to use the button', async () => {
    const all = await lab();
    all.serial.dialog = NO_GESTURE;

    await all.commands.execute(CONNECT_SERIAL);
    await tick();

    expect(notifications()).toEqual([
      [
        `The browser opens its device dialog only after a click. Use a button of the Devices panel (if no sidebar has it: ${VIEW_ITEM}).`,
        'warning'
      ]
    ]);
  });

  it('ACC-PANEL-72 the same notification follows a USB dialog and the dialog of a device request that the browser refuses for lack of a user gesture', async () => {
    const all = await lab();
    all.usb.dialog = NO_GESTURE;
    await request(all, PROBE_REQUEST);
    emit.mockClear();

    await all.commands.execute(CONNECT_USB);
    button(all, '[data-request="request-1"] [data-action="grant"]').click();
    await tick();

    expect(notifications()).toHaveLength(2);
    for (const [text, type] of notifications()) {
      expect(text).toContain(
        `Use a button of the Devices panel (if no sidebar has it: ${VIEW_ITEM}).`
      );
      expect(type).toBe('warning');
    }
    // The dialog did not open, so the request still waits for the user.
    expect(all.server.sent('request-result')).toEqual([]);
    expect(button(all, '[data-request="request-1"]')).not.toBeNull();
  });

  it('ACC-PANEL-72 a dialog the user closes raises no notification, and another failure raises one with the reason text of the browser', async () => {
    const all = await lab();

    // The simulated dialog ends as a user who picks nothing, until a test sets it.
    await all.commands.execute(CONNECT_SERIAL);
    await all.commands.execute(CONNECT_USB);
    await tick();
    expect(notifications()).toEqual([]);

    all.usb.dialog = new DOMException('Access denied.', 'NetworkError');
    await all.commands.execute(CONNECT_USB);
    await tick();
    expect(notifications()).toEqual([
      ['No device was attached: Access denied.', 'error']
    ]);
  });

  it('ACC-PANEL-70 a connect command in a browser without the device interfaces raises a notification that names HTTPS and localhost', async () => {
    const all = await lab({ interfaces: false });

    await all.commands.execute(CONNECT_SERIAL);
    await all.commands.execute(CONNECT_USB);
    await tick();

    expect(notifications()).toHaveLength(2);
    for (const [text, type] of notifications()) {
      expect(text).toMatch(/^No device was attached: .*HTTPS.*localhost/);
      expect(type).toBe('error');
    }
  });
});

describe('plugin: who opens a grant dialog', () => {
  // Node's own modules; the project has no type package for them.
  const fs = jest.requireActual('fs') as {
    readdirSync(directory: string): string[];
    readFileSync(file: string, encoding: 'utf8'): string;
  };
  const path = jest.requireActual('path') as {
    resolve(...parts: string[]): string;
  };

  it('ACC-SEC-93 no grant dialog opens at activation, for a granted device, a device request, a setting, the terminal or a row button', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      devices: [new SimUsbDevice()],
      settings: { showMenu: true, showPanel: true }
    });
    await request(all, PROBE_REQUEST, PORT_REQUEST);

    await all.commands.execute(SHOW_PANEL);
    await all.commands.execute(OPEN_TERMINAL);
    all.setShowMenu(false);
    all.setShowMenu(true);
    for (const name of [UNO_NAME, PROBE_NAME]) {
      button(all, `[data-device="${name}"] [data-action="detach"]`).click();
      await tick();
      button(all, `[data-device="${name}"] [data-action="attach"]`).click();
      await tick();
    }
    all.statusBar.registerStatusItem.mock.calls[0][1].item.node.click();
    all.server.drop();
    await tick(10000);

    // Both devices were attached more than once, and both requests were shown
    // before and after the connection to the server was lost.
    expect(all.server.sent('claim').length).toBeGreaterThanOrEqual(4);
    expect(notifications()).toHaveLength(4);
    expect(all.serial.dialogs).toEqual([]);
    expect(all.usb.dialogs).toEqual([]);
  });

  it('ACC-SEC-93 each connect command, each add button, each Grant button and each Grant action of a notification opens one grant dialog', async () => {
    const all = await lab();
    await request(all, PROBE_REQUEST, PORT_REQUEST);

    await all.commands.execute(CONNECT_SERIAL);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([1, 0]);
    await all.commands.execute(CONNECT_USB);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([1, 1]);

    button(all, '[data-action="connect-serial"]').click();
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([2, 1]);
    button(all, '[data-action="connect-usb"]').click();
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([2, 2]);

    // The simulated user picks no device, so each request ends when its dialog closes.
    button(all, '[data-request="request-1"] [data-action="grant"]').click();
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([2, 3]);
    clickAction(1);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([3, 3]);
    await tick();
  });

  it('ACC-SEC-93 only the model calls requestPort and requestDevice, and each grant method of the model has one caller, in the plugin', () => {
    const directory = path.resolve(expect.getState().testPath!, '../..');
    const sources = fs
      .readdirSync(directory)
      .filter(file => file.endsWith('.ts'))
      .map(file => ({
        file,
        // Without comments: a comment may name a call that the code does not make.
        code: fs
          .readFileSync(path.resolve(directory, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
      }));
    const filesWith = (pattern: RegExp): string[] =>
      sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
    const callsIn = (file: string, pattern: RegExp): string[] =>
      sources.find(source => source.file === file)!.code.match(pattern) || [];

    expect(sources.map(({ file }) => file)).toEqual(
      expect.arrayContaining(['index.ts', 'model.ts', 'panel.ts', 'status.ts'])
    );
    expect(filesWith(/\.requestPort\(|\.requestDevice\(/)).toEqual([
      'model.ts'
    ]);
    expect(
      filesWith(/\bmodel\.(connectSerial|connectUsb|grantRequest)\(/)
    ).toEqual(['index.ts']);
    expect(
      callsIn(
        'index.ts',
        /\bmodel\.(connectSerial|connectUsb|grantRequest)\(/g
      ).sort()
    ).toEqual([
      'model.connectSerial(',
      'model.connectUsb(',
      'model.grantRequest('
    ]);
  });
});

describe('plugin: device requests', () => {
  it('ACC-USB-47 a device request raises a notification with the program, the device and the reason, and a Grant action', async () => {
    const all = await lab();

    await request(all, PROBE_REQUEST);

    expect(emit).toHaveBeenCalledTimes(1);
    const [text, type, options] = emit.mock.calls[0];
    expect(text).toBe(
      'pyocd asks for a USB device with vendor id 0d28 and product id 0204: flash the board'
    );
    expect(type).toBe('info');
    expect(options.autoClose).toBe(false);
    expect(options.actions.map((a: { label: string }) => a.label)).toEqual([
      'Grant'
    ]);

    // The table of pending requests comes again, with a second request.
    await request(all, PORT_REQUEST);
    expect(notifications()).toEqual([
      [text, 'info'],
      ['agent asks for a serial port: read the log', 'info']
    ]);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('ACC-USB-47 the notification of a request goes when the request is answered or the server is gone, and comes again with the server', async () => {
    const all = await lab();
    await request(all, PROBE_REQUEST, PORT_REQUEST);

    all.server.pending.shift();
    all.server.push();
    await tick();
    expect(dismiss.mock.calls).toEqual([['notification-1']]);

    all.server.drop();
    await tick();
    expect(dismiss.mock.calls).toEqual([
      ['notification-1'],
      ['notification-2']
    ]);

    await tick(10000);
    expect(notifications()).toHaveLength(3);
    expect(notifications()[2][0]).toMatch(/^agent asks for a serial port/);
  });

  it('ACC-USB-48 the Grant action of the notification opens the dialog with the requested vendor and product id, attaches the device and answers the request as granted', async () => {
    const all = await lab();
    all.usb.dialog = new SimUsbDevice();
    await request(all, PROBE_REQUEST);

    clickAction(0);
    await tick();

    expect(all.usb.dialogs).toEqual([
      { filters: [{ vendorId: 0x0d28, productId: 0x0204 }] }
    ]);
    expect(all.server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-1', ok: true, name: PROBE_NAME }
    ]);
    expect(button(all, `[data-device="${PROBE_NAME}"]`).dataset.state).toBe(
      'attached'
    );
    expect(dismiss.mock.calls).toEqual([['notification-1']]);
    expect(notifications()).toHaveLength(1);
  });

  it('ACC-USB-48 the Grant button of the panel does the same for a serial port request without ids', async () => {
    const all = await lab();
    all.serial.dialog = new SimSerialPort(UNO);
    await request(all, PORT_REQUEST);

    button(all, '[data-request="request-2"] [data-action="grant"]').click();
    await tick();

    expect(all.serial.dialogs).toEqual([null]);
    expect(all.server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-2', ok: true, name: UNO_NAME }
    ]);
    expect(button(all, '[data-request]')).toBeNull();
  });

  it('ACC-USB-49 a Grant whose dialog the user closes answers the request as denied with the reason of the browser and raises no other notification', async () => {
    const all = await lab();
    await request(all, PROBE_REQUEST);

    clickAction(0);
    await tick();

    expect(all.server.sent('request-result')).toEqual([
      {
        type: 'request-result',
        id: 'request-1',
        ok: false,
        error: { name: 'NotFoundError', message: 'No device selected.' }
      }
    ]);
    expect(notifications()).toHaveLength(1);
    expect(dismiss.mock.calls).toEqual([['notification-1']]);
  });
});

describe('plugin: the serial terminal command', () => {
  const line = (name: string): object => ({
    type: 'stdin',
    content: [`jupyterlab-device terminal ${name}\r`]
  });

  it('ACC-TERM-79 with no attached port the command raises a notification and opens no lab terminal', async () => {
    const all = await lab();

    await all.commands.execute(OPEN_TERMINAL);
    await all.commands.execute(OPEN_TERMINAL, { name: UNO_NAME });

    const message = `No serial port is attached. Add a serial port in the Devices panel first (if no sidebar has the panel: ${VIEW_ITEM}).`;
    expect(notifications()).toEqual([
      [message, 'warning'],
      [message, 'warning']
    ]);
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('ACC-TERM-79 a detached port and a USB device are no attached port: the command opens no lab terminal', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      devices: [new SimUsbDevice()]
    });
    button(all, `[data-device="${UNO_NAME}"] [data-action="detach"]`).click();
    await tick();

    await all.commands.execute(OPEN_TERMINAL);

    expect(notifications()).toHaveLength(1);
    expect(notifications()[0][0]).toMatch(/^No serial port is attached\./);
    expect(all.newTerminal).not.toHaveBeenCalled();
  });

  it('ACC-TERM-111 where the server offers no terminals the command shows the command line to run and opens no lab terminal', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      terminals: false
    });

    await all.commands.execute(OPEN_TERMINAL);

    expect(emit.mock.calls).toEqual([
      [
        `This server offers no terminals. Run this command in a shell of the container: jupyterlab-device terminal ${UNO_NAME}`,
        'info',
        { autoClose: false }
      ]
    ]);
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(all.session.send).not.toHaveBeenCalled();
  });

  it('ACC-TERM-74 with one attached port the command opens a lab terminal and types the terminal command of the CLI for that port', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await all.commands.execute(OPEN_TERMINAL);

    expect(all.newTerminal).toHaveBeenCalledTimes(1);
    expect(all.session.send.mock.calls).toEqual([[line(UNO_NAME)]]);
    expect(getItem).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  it('ACC-TERM-74 the command line is typed once, when the terminal is connected', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    const status = (next: ISession['connectionStatus']): void => {
      all.session.connectionStatus = next;
      all.session.connectionStatusChanged.emit(next);
    };
    all.session.connectionStatus = 'connecting';

    await all.commands.execute(OPEN_TERMINAL);
    expect(all.session.send).not.toHaveBeenCalled();

    status('disconnected');
    expect(all.session.send).not.toHaveBeenCalled();

    status('connected');
    expect(all.session.send.mock.calls).toEqual([[line(UNO_NAME)]]);

    // A terminal that connects again later gets no second command line.
    status('disconnected');
    status('connected');
    expect(all.session.send).toHaveBeenCalledTimes(1);
  });

  it('ACC-TERM-74 with several attached ports the command asks which one, and a closed question opens no lab terminal', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO), new SimSerialPort(NANO)]
    });

    getItem.mockResolvedValueOnce({
      button: { accept: true },
      value: NANO_NAME
    });
    await all.commands.execute(OPEN_TERMINAL);

    expect(getItem).toHaveBeenCalledTimes(1);
    expect(getItem.mock.calls[0][0]).toMatchObject({
      items: [UNO_NAME, NANO_NAME],
      editable: false
    });
    expect(all.session.send.mock.calls).toEqual([[line(NANO_NAME)]]);

    getItem.mockResolvedValueOnce({ button: { accept: false }, value: null });
    await all.commands.execute(OPEN_TERMINAL);

    expect(all.newTerminal).toHaveBeenCalledTimes(1);
    expect(all.session.send).toHaveBeenCalledTimes(1);
  });

  it('ACC-TERM-74 the Terminal button of a row and the argument name open the terminal on that port without a question', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO), new SimSerialPort(NANO)]
    });

    button(
      all,
      `[data-device="${NANO_NAME}"] [data-action="terminal"]`
    ).click();
    await tick();
    await all.commands.execute(OPEN_TERMINAL, { name: UNO_NAME });

    expect(all.session.send.mock.calls).toEqual([
      [line(NANO_NAME)],
      [line(UNO_NAME)]
    ]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('ACC-TERM-79 a name that is no attached serial port raises a notification and reaches no command line', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      devices: [new SimUsbDevice()]
    });

    for (const name of ['tty-0000-0000', PROBE_NAME, `${UNO_NAME}; id`, 7]) {
      await all.commands.execute(OPEN_TERMINAL, { name });
    }

    expect(notifications()).toEqual([
      ['No attached serial port has the name tty-0000-0000.', 'warning'],
      [`No attached serial port has the name ${PROBE_NAME}.`, 'warning'],
      [`No attached serial port has the name ${UNO_NAME}; id.`, 'warning'],
      ['No attached serial port has the name 7.', 'warning']
    ]);
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(all.session.send).not.toHaveBeenCalled();
  });
});

describe('plugin: the Devices menu', () => {
  const menus = (all: ILab): Menu[] =>
    all.mainMenu.addMenu.mock.calls.map(([menu]) => menu);

  it('ACC-PANEL-68 with the default settings the lab gets no Devices menu', async () => {
    const all = await lab({ settings: {} });

    expect(menus(all)).toEqual([]);
  });

  it('ACC-PANEL-69 with showMenu true the lab gets a Devices menu with the four commands', async () => {
    const all = await lab({ settings: { showMenu: true } });

    expect(menus(all)).toHaveLength(1);
    const [menu] = menus(all);
    expect(menu).toBeInstanceOf(Menu);
    expect(menu.title.label).toBe('Devices');
    expect(menu.id).toBe('jp-mainmenu-devices');
    expect(menu.items.map(item => item.command)).toEqual([
      CONNECT_SERIAL,
      CONNECT_USB,
      OPEN_TERMINAL,
      SHOW_PANEL
    ]);
    expect(menu.items.map(item => item.label)).toEqual([
      'Connect Serial Port',
      'Connect USB Device',
      'Serial Terminal',
      'Show Devices Panel'
    ]);
  });

  it('ACC-PANEL-69 the menu is added when showMenu becomes true and removed when it becomes false, without a reload', async () => {
    const all = await lab();

    all.setShowMenu(true);
    expect(menus(all)).toHaveLength(1);
    expect(menus(all)[0].isDisposed).toBe(false);

    // A change of the settings that leaves showMenu true adds no second menu.
    all.setShowMenu(true);
    expect(menus(all)).toHaveLength(1);

    // The main menu of the lab removes a menu when the menu is disposed.
    all.setShowMenu(false);
    expect(menus(all)[0].isDisposed).toBe(true);
    all.setShowMenu(false);

    all.setShowMenu(true);
    expect(menus(all)).toHaveLength(2);
    expect(menus(all)[1].isDisposed).toBe(false);
    expect(menus(all)[1].items).toHaveLength(4);
  });

  it('ACC-PANEL-69 the entry Connect Serial Port of the menu opens the port dialog', async () => {
    const all = await lab({ settings: { showMenu: true } });
    const [menu] = menus(all);

    await all.commands.execute(menu.items[0].command, menu.items[0].args);

    expect(all.serial.dialogs).toEqual([null]);
  });
});

describe('plugin: the status bar item', () => {
  /** What the plugin gave to the status bar. */
  const registered = (
    all: ILab
  ): {
    item: DeviceBridgeStatus;
    isActive: () => boolean;
    activeStateChanged: Signal<DeviceBridgeStatus, void>;
    priority: number;
  } => all.statusBar.registerStatusItem.mock.calls[0][1];

  it('ACC-PANEL-66 the status item is active only while a device is attached, and says so each time that changes', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab();
    const { item, isActive, activeStateChanged, priority } = registered(all);
    const changes: boolean[] = [];
    activeStateChanged.connect(() => changes.push(isActive()));
    const count = (): string | null =>
      item.node.querySelector('[data-field="count"]')!.textContent;
    const label = (): string | null =>
      item.node.querySelector('.jp-DeviceBridgeStatus-label')!.textContent;

    expect(all.statusBar.registerStatusItem).toHaveBeenCalledTimes(1);
    expect(all.statusBar.registerStatusItem.mock.calls[0][0]).toBe(
      'jupyterlab_device_bridge_extension:status'
    );
    expect(item).toBeInstanceOf(DeviceBridgeStatus);
    expect(item.id).toBe('jupyterlab-device-bridge-status');
    expect(item.node.classList.contains('jp-DeviceBridgeStatus')).toBe(true);
    expect(item.node.querySelector('svg')).not.toBeNull();
    // Above zero: the status bar hides an item of priority zero in a narrow window.
    expect(priority).toBeGreaterThan(0);
    expect(isActive()).toBe(false);

    all.serial.dialog = port;
    await all.commands.execute(CONNECT_SERIAL);
    await tick();
    expect(isActive()).toBe(true);
    expect(count()).toBe('1');
    expect(label()).toBe('device');
    expect(changes).toEqual([true]);

    all.usb.dialog = new SimUsbDevice();
    await all.commands.execute(CONNECT_USB);
    await tick();
    expect(count()).toBe('2');
    expect(label()).toBe('devices');
    expect(item.node.title).toMatch(/access to 2 devices of this computer/);
    expect(changes).toEqual([true, true]);

    // Bytes change the device table and not the number of attached devices.
    port.receive([1, 2, 3]);
    await tick(1000);
    expect(changes).toEqual([true, true]);

    button(all, `[data-device="${UNO_NAME}"] [data-action="detach"]`).click();
    button(all, `[data-device="${PROBE_NAME}"] [data-action="detach"]`).click();
    await tick();
    expect(isActive()).toBe(false);
    expect(count()).toBe('0');
    expect(changes).toEqual([true, true, true, false]);
  });

  it('ACC-PANEL-66 a device that another tab holds counts, and a click on the item opens the panel', async () => {
    const all = await lab({ settings: { showPanel: true } });
    const { item, isActive } = registered(all);
    all.server.table.usb.push({
      name: PROBE_NAME,
      state: 'attached',
      tab: 'tab-2',
      vendorId: 0x0d28,
      productId: 0x0204,
      productName: null,
      manufacturerName: null,
      serialNumber: null,
      opened: false,
      holder: null,
      rx: 0,
      tx: 0,
      error: null
    });
    all.server.push();
    await tick();

    expect(isActive()).toBe(true);
    expect(item.count).toBe(1);

    item.node.click();
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);
  });
});

describe('plugin: the option showPanel', () => {
  /** The status bar item the plugin registered. */
  const statusItem = (all: ILab): DeviceBridgeStatus =>
    all.statusBar.registerStatusItem.mock.calls[0][1].item;

  /** Every `changed` notice of the command registry for the command show-panel. */
  const marks = (all: ILab): string[] => {
    const seen: string[] = [];
    all.commands.commandChanged.connect((_, change) => {
      if (change.id === SHOW_PANEL && change.type === 'changed') {
        seen.push(change.id);
      }
    });
    return seen;
  };

  it('ACC-PANEL-113 with the default settings the panel is not in the sidebar, the command is not toggled, and the bridge runs', async () => {
    const all = await lab({ settings: {}, ports: [new SimSerialPort(UNO)] });

    expect(SCHEMA_DEFAULTS.showPanel).toBe(false);
    expect(all.shell.add).toHaveBeenCalledTimes(0);
    expect(all.sidebar.widgets.length).toBe(0);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    expect(all.shell.activateById).not.toHaveBeenCalled();
    // The granted port is attached all the same.
    expect(statusItem(all).count).toBe(1);
  });

  it('ACC-PANEL-113 the layout restorer learns the panel when the panel is shown the first time and not before, so a saved layout does not bring a hidden panel back', async () => {
    const all = await lab({ settings: {} });

    // The lab puts every widget the restorer knows into the sidebar when the saved
    // layout names it. A hidden panel is unknown to the restorer.
    expect(all.restorer.add).toHaveBeenCalledTimes(0);

    all.setSetting('showPanel', true);
    expect(restorerAdds(all)).toEqual([[true, PANEL_ID]]);

    all.setSetting('showPanel', false);
    all.setSetting('showPanel', true);
    expect(all.restorer.add).toHaveBeenCalledTimes(1);
    expect(all.shell.add).toHaveBeenCalledTimes(2);
  });

  it('ACC-PANEL-115 with showPanel true in the settings the panel is in the left sidebar and known to the layout restorer when the activation ends, and the command is toggled', async () => {
    const all = await lab({ settings: { showPanel: true } });

    expect(all.shownWhenActivated).toBe(true);
    expect(restorerAdds(all)).toEqual([[true, PANEL_ID]]);
    expect(inSidebar(all)).toBe(true);
    expect(all.panel.isAttached).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    // The lab restores which sidebar panel is open; the plugin opens none at the start.
    expect(all.shell.activateById).not.toHaveBeenCalled();
    expect(all.settings.set).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-114 the command show-panel writes showPanel true, puts the panel into the left sidebar, opens it and is toggled; executed again it writes false and removes the panel and the mark', async () => {
    const all = await lab({ settings: {} });
    const changed = marks(all);

    await all.commands.execute(SHOW_PANEL);

    expect(all.settings.set.mock.calls).toEqual([['showPanel', true]]);
    expect(all.settings.composite.showPanel).toBe(true);
    expect(shellAdds(all)).toEqual([[true, 'left', { rank: 600 }]]);
    expect(inSidebar(all)).toBe(true);
    expect(all.panel.isAttached).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(changed).toHaveLength(1);

    await all.commands.execute(SHOW_PANEL);

    expect(all.settings.set.mock.calls).toEqual([
      ['showPanel', true],
      ['showPanel', false]
    ]);
    expect(inSidebar(all)).toBe(false);
    expect(all.panel.isAttached).toBe(false);
    expect(all.sidebar.widgets.length).toBe(0);
    expect(all.panel.isDisposed).toBe(false);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    expect(changed).toHaveLength(2);
    // Hiding opens nothing.
    expect(all.shell.activateById).toHaveBeenCalledTimes(1);

    // The same panel object comes back.
    await all.commands.execute(SHOW_PANEL);
    expect(shellAdds(all)).toEqual([
      [true, 'left', { rank: 600 }],
      [true, 'left', { rank: 600 }]
    ]);
    expect(inSidebar(all)).toBe(true);
    expect(all.restorer.add).toHaveBeenCalledTimes(1);
  });

  it('ACC-PANEL-115 a change of the setting showPanel adds and removes the panel and sets the mark of the command, without a reload and without the command', async () => {
    const all = await lab({ settings: {} });
    const changed = marks(all);

    all.setSetting('showPanel', true);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(changed).toHaveLength(1);

    // A change of another setting leaves the panel where it is.
    all.setShowMenu(true);
    all.setSetting('defaultBaudRate', 9600);
    expect(all.shell.add).toHaveBeenCalledTimes(1);
    expect(changed).toHaveLength(1);

    all.setSetting('showPanel', false);
    expect(inSidebar(all)).toBe(false);
    expect(all.sidebar.widgets.length).toBe(0);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    expect(changed).toHaveLength(2);

    // Only the command and the status bar item open the panel and write the setting.
    expect(all.shell.activateById).not.toHaveBeenCalled();
    expect(all.settings.set).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-116 hiding the panel releases no device: the port stays open, bytes still reach it, the status bar item counts it and a device request still raises its notification', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({
      ports: [port],
      settings: { showPanel: true }
    });
    const [claimed] = all.server.table.serial;
    expect(claimed.state).toBe('attached');

    await all.commands.execute(SHOW_PANEL);
    expect(inSidebar(all)).toBe(false);
    all.server.sendData(1, [0x55, 0xaa]);
    await request(all, PORT_REQUEST);
    await tick(2000);

    expect(all.server.sent('release')).toEqual([]);
    expect(all.server.sent('claim')).toHaveLength(1);
    expect(all.server.sockets).toHaveLength(1);
    expect(port.opens).toHaveLength(1);
    expect(port.closes).toBe(0);
    expect(port.written).toEqual([0x55, 0xaa]);
    expect(all.server.table.serial[0].state).toBe('attached');
    expect(statusItem(all).count).toBe(1);
    expect(notifications()).toEqual([
      ['agent asks for a serial port: read the log', 'info']
    ]);
    // The hidden panel still follows the device table, so it is current when it is shown.
    expect(
      all.panel.node.querySelector<HTMLElement>(`[data-device="${UNO_NAME}"]`)!
        .dataset.state
    ).toBe('attached');
  });

  it('ACC-PANEL-117 a click on the status bar item while the panel is hidden writes showPanel true and opens the panel; while the panel is shown the click only opens it', async () => {
    const all = await lab({ settings: {}, ports: [new SimSerialPort(UNO)] });
    expect(statusItem(all).count).toBe(1);

    statusItem(all).node.click();
    await tick();

    expect(all.settings.set.mock.calls).toEqual([['showPanel', true]]);
    expect(all.settings.composite.showPanel).toBe(true);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);

    statusItem(all).node.click();
    await tick();

    expect(all.settings.set).toHaveBeenCalledTimes(1);
    expect(inSidebar(all)).toBe(true);
    expect(all.shell.add).toHaveBeenCalledTimes(1);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID], [PANEL_ID]]);
  });

  it('ACC-PANEL-122 the command shows the panel, opens it and is toggled at once, and the lab saves the setting after that', async () => {
    const all = await lab({ settings: {} });

    const saved = all.commands.execute(SHOW_PANEL);

    // The save has not ended: the stored value is still false.
    expect(all.settings.set.mock.calls).toEqual([['showPanel', true]]);
    expect(all.settings.composite.showPanel).toBe(false);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);

    await saved;
    expect(all.settings.composite.showPanel).toBe(true);
    expect(inSidebar(all)).toBe(true);
    expect(all.shell.add).toHaveBeenCalledTimes(1);

    // Hiding has the same order.
    const hidden = all.commands.execute(SHOW_PANEL);
    expect(all.settings.composite.showPanel).toBe(true);
    expect(inSidebar(all)).toBe(false);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    await hidden;
    expect(all.settings.composite.showPanel).toBe(false);
    expect(notifications()).toEqual([]);
  });

  it('ACC-PANEL-122 when the lab cannot save the setting the panel stays as the command set it, the command is toggled, and one warning names the setting and the reason', async () => {
    const all = await lab({ settings: {}, saveFails: true });

    // The command ends without an error.
    await all.commands.execute(SHOW_PANEL);
    await tick();

    expect(all.settings.set.mock.calls).toEqual([['showPanel', true]]);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);
    expect(notifications()).toEqual([notSaved('shown')]);

    await all.commands.execute(SHOW_PANEL);
    await tick();

    expect(inSidebar(all)).toBe(false);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    expect(notifications()).toEqual([notSaved('shown'), notSaved('hidden')]);
    expect(all.settings.composite.showPanel).toBe(false);
  });

  it('ACC-PANEL-122 a click on the status bar item shows and opens the hidden panel at once, and a save that fails raises one warning and leaves no rejected promise', async () => {
    const all = await lab({
      settings: {},
      saveFails: true,
      ports: [new SimSerialPort(UNO)]
    });

    statusItem(all).node.click();

    // At the click, before the save has ended.
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);
    expect(notifications()).toEqual([]);

    await tick();
    // Node reports a rejected promise without a handler when a task of the event loop
    // ends, and Jest then fails the test that runs. So the test lives through one task.
    await new Promise(resolve =>
      jest.requireActual('timers').setImmediate(resolve)
    );

    expect(inSidebar(all)).toBe(true);
    expect(notifications()).toEqual([notSaved('shown')]);
  });

  it('ACC-PANEL-122 a change in the Settings Editor after a save that failed applies the stored value', async () => {
    const all = await lab({ settings: {}, saveFails: true });
    await all.commands.execute(SHOW_PANEL);
    await tick();
    expect(inSidebar(all)).toBe(true);

    // The stored value is still false, and the lab reports the settings as changed.
    all.setSetting('defaultBaudRate', 9600);
    expect(inSidebar(all)).toBe(false);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);

    all.setSetting('showPanel', true);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
  });

  it('ACC-PANEL-114 without the setting registry the option is kept in memory: it starts false and the command toggles it', async () => {
    const all = await lab({ services: false });

    expect(all.shell.add).toHaveBeenCalledTimes(0);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);

    await all.commands.execute(SHOW_PANEL);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    expect(all.shell.activateById.mock.calls).toEqual([[PANEL_ID]]);

    await all.commands.execute(SHOW_PANEL);
    expect(inSidebar(all)).toBe(false);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(false);
    expect(all.shell.activateById).toHaveBeenCalledTimes(1);
    expect(all.settings.set).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-114 when the settings fail to load the plugin logs the error and activates with the panel hidden, and the command toggles the option in memory', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    const all = await lab({
      loadFails: true,
      ports: [new SimSerialPort(UNO)]
    });

    expect(logged.mock.calls).toEqual([
      [
        'Failed to load the settings of jupyterlab_device_bridge_extension.',
        new Error('The schema is missing.')
      ]
    ]);
    expect(all.shell.add).toHaveBeenCalledTimes(0);
    expect(all.mainMenu.addMenu).not.toHaveBeenCalled();
    // The bridge runs, with the settings of the server's default profile.
    expect(statusItem(all).count).toBe(1);
    expect(all.server.sent('claim')[0]).not.toHaveProperty('defaults');

    await all.commands.execute(SHOW_PANEL);
    expect(inSidebar(all)).toBe(true);
    expect(all.commands.isToggled(SHOW_PANEL)).toBe(true);
    await all.commands.execute(SHOW_PANEL);
    expect(inSidebar(all)).toBe(false);
  });
});

describe('plugin: the default serial settings', () => {
  /** Settings of the lab in which every default serial setting differs from the schema. */
  const CHANGED = {
    defaultBaudRate: 9600,
    defaultDataBits: 7,
    defaultParity: 'even',
    defaultStopBits: 2,
    defaultOnOpen: 'pulse-dtr'
  };
  const CHANGED_DEFAULTS: ISerialDefaults = {
    baudRate: 9600,
    dataBits: 7,
    parity: 'even',
    stopBits: 2,
    onOpen: 'pulse-dtr'
  };

  it('ACC-PROF-118 the plugin gives the worker the five default settings before the worker connects, so the claim of a port granted earlier carries them', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      settings: CHANGED
    });

    expect(all.server.sent('claim')).toEqual([
      {
        type: 'claim',
        kind: 'serial',
        key: UNO_KEY,
        info: UNO,
        defaults: CHANGED_DEFAULTS
      }
    ]);
  });

  it('ACC-PROF-118 with the default settings of the schema the claim carries 115200 baud, 8 data bits, no parity, 1 stop bit and no action on open', async () => {
    const all = await lab({ settings: {}, ports: [new SimSerialPort(UNO)] });

    expect(all.server.sent('claim').map(claim => claim.defaults)).toEqual([
      MONITOR_DEFAULTS
    ]);
  });

  it('ACC-PROF-118 without the setting registry the claim of a serial port has no field defaults', async () => {
    const all = await lab({
      services: false,
      ports: [new SimSerialPort(UNO)]
    });

    expect(all.server.sent('claim')).toHaveLength(1);
    expect(all.server.sent('claim')[0]).not.toHaveProperty('defaults');
  });

  it('ACC-PROF-119 a default setting that changes reaches the claim of the next port without a reload, and the attached port is not claimed or opened again', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });

    all.setSetting('defaultBaudRate', 57600);
    all.setSetting('defaultOnOpen', 'pulse-rts');
    await tick();
    expect(all.server.sent('claim')).toHaveLength(1);
    expect(port.opens).toHaveLength(1);

    all.serial.dialog = new SimSerialPort(NANO);
    await all.commands.execute(CONNECT_SERIAL);
    await tick();

    expect(all.server.sent('claim').map(claim => claim.defaults)).toEqual([
      MONITOR_DEFAULTS,
      { ...MONITOR_DEFAULTS, baudRate: 57600, onOpen: 'pulse-rts' }
    ]);
    expect(all.server.sockets).toHaveLength(1);
    expect(port.opens).toHaveLength(1);
  });
});

describe('plugin: texts that send the user to the Devices panel', () => {
  // Node's own modules; the project has no type package for them.
  const fs = jest.requireActual('fs') as {
    readFileSync(file: string, encoding: 'utf8'): string;
  };
  const path = jest.requireActual('path') as {
    resolve(...parts: string[]): string;
  };

  it('ACC-CLI-124 the notification of a dialog without a user gesture and the notification of a terminal without a port each name the View menu item Show Devices Panel, once', async () => {
    const all = await lab({ settings: {} });
    all.serial.dialog = NO_GESTURE;

    await all.commands.execute(CONNECT_SERIAL);
    await all.commands.execute(OPEN_TERMINAL);
    await tick();

    const texts = notifications().map(([text]) => text);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain('Devices panel');
      // The item is a toggle: the text names it for a panel that no sidebar has.
      expect(text).toMatch(/\(if no sidebar has (it|the panel): View → /);
      expect(text.split(VIEW_ITEM)).toHaveLength(2);
      expect(text.split('Show Devices Panel')).toHaveLength(2);
      // The lab cuts a notification after 140 characters.
      expect(text.length).toBeLessThanOrEqual(140);
    }
  });

  it('ACC-CLI-124 every text in the source of the plugin, the model and the worker that names the Devices panel names the View menu item', () => {
    const directory = path.resolve(expect.getState().testPath!, '../..');
    const texts: string[] = [];
    for (const file of ['index.ts', 'model.ts', 'worker.ts']) {
      const code = fs
        .readFileSync(path.resolve(directory, file), 'utf8')
        // Without comments: a comment may name the panel and is no text for the user.
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      texts.push(
        ...(code.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [])
      );
    }
    // The warning about a setting that was not saved says what the panel does and sends
    // the user nowhere: the user has just shown or hidden the panel.
    const sending = texts.filter(
      text =>
        text.includes('Devices panel') &&
        !text.includes('could not save the setting showPanel')
    );

    // The two notifications of the plugin; the texts inside the panel and the
    // tooltip of the status bar item are read by a user who sees the panel or the item.
    expect(sending).toHaveLength(2);
    for (const text of sending) {
      expect(text.split(VIEW_ITEM)).toHaveLength(2);
    }
  });
});
