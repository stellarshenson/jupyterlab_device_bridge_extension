/**
 * The plugin against the real model, the real worker function, the real panel,
 * simulated devices and a simulated server.
 *
 * The lab is a small stand-in: a real command registry, a shell that records, and the
 * optional services as recorders. The lab packages that Jest cannot load are replaced:
 * the notifications and the dialogs by recorders, the icon of the panel by its SVG
 * text. The plus icon and its menu are those of the lab.
 */

import { InputDialog, Notification, showDialog } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';

import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Menu, Panel, Widget } from '@lumino/widgets';

import plugin from '../index';
import { HELP_MARKDOWN } from '../help';
import { deviceIcon } from '../icons';
import { DeviceBridgePanel } from '../panel';
import type { IDeviceRequest, IRunRecord, ISerialDefaults } from '../protocol';
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
  // A button of a dialog is its options, with the kind of the button.
  Dialog: { okButton: (options: object) => ({ kind: 'ok', ...options }) },
  ICommandPalette: 'ICommandPalette',
  InputDialog: { getItem: jest.fn() },
  Notification: { emit: jest.fn(), dismiss: jest.fn() },
  showDialog: jest.fn()
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
  },
  // Jest cannot load the index of the package. It loads these two modules of it.
  addIcon: jest.requireActual('@jupyterlab/ui-components/lib/icon/iconimports')
    .addIcon,
  MenuSvg: jest.requireActual(
    '@jupyterlab/ui-components/lib/icon/widgets/menusvg'
  ).MenuSvg
}));
jest.mock('../worker', () => ({
  ...jest.requireActual('../worker'),
  createWorker: jest.fn()
}));

const CONNECT_SERIAL = 'device-bridge:connect-serial';
const CONNECT_USB = 'device-bridge:connect-usb';
const OPEN_TERMINAL = 'device-bridge:open-terminal';
const START_RUN = 'device-bridge:start-run';
const SHOW_PANEL = 'device-bridge:show-panel';
/** The command of the lab that opens a file in its read-only Markdown Preview. */
const MARKDOWN_VIEWER_OPEN = 'markdownviewer:open';
/** The file at the root of the contents that holds the help document. */
const HELP_PATH = 'Device Bridge Help';
/** The id that the plugin gives the help tab when the viewer gives it none. */
const HELP_ID = 'device-bridge-help';
/** The command of jupyterlab_basic_terminal_extension that starts one program in a lab terminal. */
const BASIC_TERMINAL_LAUNCH = 'basic-terminal:launch';
/** The command of the lab that opens a terminal with a shell. The plugin never runs it. */
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
/** A terminal shell that runs with the shim. */
const SHELL_RUN: IRunRecord = {
  pid: 4242,
  program: 'bash',
  command: '/bin/bash',
  device: null
};
/** The directory in which the simulated server makes the virtual serial devices. */
const DEVICE_DIR = '/tmp/jupyterlab-device-1000';

const emit = Notification.emit as jest.Mock;
const dismiss = Notification.dismiss as jest.Mock;
const getItem = InputDialog.getItem as jest.Mock;
const dialog = showDialog as jest.Mock;

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

/**
 * The title of the terminal widget that `basic-terminal:launch` returns, before the
 * plugin sets the identity of its tab.
 */
const LAUNCH_TITLE = { label: '1', icon: { name: 'terminal' }, caption: '' };

/** The title of the widget-like object that the stand-in of `basic-terminal:launch` returns. */
interface ILaunchTitle {
  label: string;
  icon: unknown;
  caption: string;
  /** Says that the title changed, as the Title of the lab does. */
  changed: Signal<ILaunchTitle, void>;
}

/** The widget-like object that the stand-in of `basic-terminal:launch` returns. */
interface ILaunchWidget {
  id: string;
  title: ILaunchTitle;
}

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
  shell: {
    add: jest.Mock;
    activateById: jest.Mock;
    widgets: jest.Mock;
  };
  /** Stands for the left sidebar of the lab: `shell.add` puts a widget into it. */
  sidebar: Panel;
  /** Stands for the main area of the lab: `shell.add` with the area main puts a widget into it. */
  main: Panel;
  /** The stand-in of the contents API of the server: the read and the write of the help file. */
  contents: { get: jest.Mock; save: jest.Mock };
  /** The stand-in of the command `markdownviewer:open`: it records its arguments. */
  markdown: jest.Mock;
  palette: { addItem: jest.Mock };
  mainMenu: { addMenu: jest.Mock };
  statusBar: { registerStatusItem: jest.Mock };
  restorer: { add: jest.Mock };
  settings: ISettings;
  /** The one panel of the plugin: the first widget it added to the shell. */
  readonly panel: DeviceBridgePanel;
  /** Whether the panel was in the sidebar at the moment the activation of the plugin ended. */
  shownWhenActivated: boolean;
  /** The stand-in of the command `basic-terminal:launch`: it records its arguments. */
  launch: jest.Mock;
  /** The widget-like object of every `basic-terminal:launch` call, in order. */
  launchWidgets: ILaunchWidget[];
  /** The stand-in of the command of the lab that opens a terminal with a shell. */
  newTerminal: jest.Mock;
  /** Change one setting as the Settings Editor of the lab does. */
  setSetting(key: string, value: unknown): void;
  /** Change the setting `showMenu` as the Settings Editor of the lab does. */
  setShowMenu(show: boolean): void;
}

interface ILabOptions {
  ports?: SimSerialPort[];
  devices?: SimUsbDevice[];
  /** The device interfaces the browser has; both unless a test says otherwise. On plain http it has none. */
  interfaces?: Array<'serial' | 'usb'>;
  /** False: the server offers no terminals. */
  terminals?: boolean;
  /** False: the lab has no command `basic-terminal:launch`, as without jupyterlab_basic_terminal_extension. */
  launcher?: boolean;
  /** False: the lab has none of the optional services. */
  services?: boolean;
  /** True: the setting registry fails to load the settings of the plugin. */
  loadFails?: boolean;
  /** True: the lab cannot save a setting; `settings.set` rejects with the reason `SAVE_REFUSED`. */
  saveFails?: boolean;
  /**
   * The id that the stand-in of the Markdown viewer gives its widget before the plugin
   * sees it, as the document manager of the lab does. The default is a
   * `document-manager-<n>` id; `''` gives the widget no id.
   */
  viewerId?: string;
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
  const interfaces = options.interfaces || ['serial', 'usb'];
  const offered = {
    serial: interfaces.includes('serial') ? serial : undefined,
    usb: interfaces.includes('usb') ? usb : undefined
  };
  const scope = new SimScope(server, offered.serial, offered.usb);
  setInterface('serial', offered.serial);
  setInterface('usb', offered.usb);
  (createWorker as jest.Mock).mockImplementation(() => {
    workerMain(scope);
    return scope.page;
  });

  const launchWidgets: ILaunchWidget[] = [];
  const launch = jest.fn(async () => {
    const title = { ...LAUNCH_TITLE } as ILaunchTitle;
    // The Title of the lab has the signal; toEqual of a title must still see only
    // the three fields, so the signal is not an enumerable property.
    Object.defineProperty(title, 'changed', {
      value: new Signal<ILaunchTitle, void>(title)
    });
    const widget = {
      id: `launched-terminal-${launchWidgets.length + 1}`,
      title
    };
    launchWidgets.push(widget);
    return widget;
  });
  const newTerminal = jest.fn(async () => ({ id: 'shell-terminal' }));
  const commands = new CommandRegistry();
  commands.addCommand(NEW_LAB_TERMINAL, { execute: newTerminal });
  if (options.launcher !== false) {
    commands.addCommand(BASIC_TERMINAL_LAUNCH, { execute: launch });
  }

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
  const main = new Panel();
  Widget.attach(main, document.body);
  const shell = {
    add: jest.fn((widget: Widget, area?: string) =>
      area === 'main' ? main.addWidget(widget) : sidebar.addWidget(widget)
    ),
    activateById: jest.fn(),
    widgets: jest.fn((area: string) => (area === 'main' ? main.widgets : []))
  };
  // The stand-in of the Markdown Preview: the document manager puts the widget into
  // the main area and gives it an id of its own unless a test says otherwise.
  let opened = 0;
  const markdown = jest.fn(async (args: { path?: string }) => {
    const widget = new Widget();
    widget.title.label = (args.path ?? '').split('/').pop() ?? '';
    (widget as Widget & { content: unknown }).content = {
      context: { path: args.path }
    };
    if (options.viewerId === undefined) {
      widget.id = `document-manager-${++opened}`;
    } else if (options.viewerId) {
      widget.id = options.viewerId;
    }
    shell.add(widget, 'main');
    return widget;
  });
  commands.addCommand(MARKDOWN_VIEWER_OPEN, { execute: markdown });
  const contents = {
    // The contents API answers 404 for a path that the server does not have.
    get: jest.fn(async () => {
      throw new ServerConnection.ResponseError({
        status: 404,
        statusText: 'Not Found'
      } as unknown as Response);
    }),
    save: jest.fn(async () => ({}))
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
      terminals: { isAvailable: () => options.terminals !== false },
      contents
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
    main,
    contents,
    markdown,
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
    launch,
    launchWidgets,
    newTerminal,
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

/** The plus icon of the panel header. */
const plus = (all: ILab): HTMLButtonElement =>
  button(all, '[data-action="add-device"]');

/** Whether the plus menu is open: the page then holds its one menu. */
const menuOpen = (): boolean =>
  document.body.querySelectorAll('.lm-Menu').length === 1;

/** Every entry of the open plus menu: its command and its label. */
const entries = (): Array<[string | undefined, string | null]> =>
  Array.from(
    document.body.querySelectorAll<HTMLElement>('li.lm-Menu-item'),
    entry => [
      entry.dataset.command,
      entry.querySelector('.lm-Menu-itemLabel')!.textContent
    ]
  );

/**
 * Choose an entry of the open plus menu as a click does: the pointer goes up over the
 * entry. Lumino finds the entry under the pointer by its rectangle, and jsdom gives
 * every element an empty rectangle, so the entry gets one first. jsdom has no
 * PointerEvent; Lumino reads the type, the button and the place of the event.
 */
function pick(command: string): void {
  const entry = document.body.querySelector<HTMLElement>(
    `li.lm-Menu-item[data-command="${command}"]`
  )!;
  const rectangle = jest
    .spyOn(entry, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, right: 100, top: 0, bottom: 20 } as DOMRect);
  entry.dispatchEvent(
    new MouseEvent('pointerup', { bubbles: true, clientX: 1, clientY: 1 })
  );
  rectangle.mockRestore();
}

/**
 * The list of words of every launch, in order. A launch has this list and
 * `shutdownOnClose: true` (DEF-SERIAL-20) and nothing else: no folder.
 */
const launches = (all: ILab): string[][] =>
  all.launch.mock.calls.map(([args]) => {
    expect(Object.keys(args).sort()).toEqual(['argv', 'shutdownOnClose']);
    expect(args.shutdownOnClose).toBe(true);
    return args.argv as string[];
  });

/** The command line of every launch, in words: what follows `/bin/bash -c <script>`. */
const launchedLines = (all: ILab): string[][] =>
  launches(all).map(argv => {
    expect(argv.slice(0, 2)).toEqual(['/bin/bash', '-c']);
    return argv.slice(3);
  });

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
  // The dialog of the lab resolves when the user closes it.
  dialog.mockReset().mockResolvedValue({ button: { accept: true } });
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
  it('ACC-PANEL-67 the plugin registers its five commands, lists them in the palette under Devices and, with showPanel true, adds the panel to the left sidebar', async () => {
    const all = await lab({ settings: { showPanel: true } });
    const ids = [
      CONNECT_SERIAL,
      CONNECT_USB,
      OPEN_TERMINAL,
      START_RUN,
      SHOW_PANEL
    ];

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
      true,
      true
    ]);
    expect(ids.map(id => all.commands.label(id))).toEqual([
      'Connect Serial Port',
      'Connect USB Device',
      'Serial Terminal',
      'Device Shell',
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
    expect(all.launch).toHaveBeenCalledTimes(1);
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

describe('plugin: the plus icon of the panel', () => {
  const SERIAL_ENTRY = [CONNECT_SERIAL, 'Connect Serial Port'];
  const USB_ENTRY = [CONNECT_USB, 'Connect USB Device'];

  /** For each connect command: whether the registry has it, whether it is enabled, and whether the palette lists it. */
  const offered = (all: ILab): boolean[][] =>
    [CONNECT_SERIAL, CONNECT_USB].map(command => [
      all.commands.hasCommand(command),
      all.commands.isEnabled(command),
      all.palette.addItem.mock.calls.some(([item]) => item.command === command)
    ]);

  it('ACC-PANEL-153 the plus icon opens a menu with the entries Connect Serial Port and Connect USB Device, an entry opens the dialog of the browser, and the granted device is listed as attached', async () => {
    const all = await lab();
    all.serial.dialog = new SimSerialPort(UNO);
    all.usb.dialog = new SimUsbDevice();

    plus(all).click();

    // The plugin built the menu before it added the commands: the menu reads the
    // label of an entry when it is drawn.
    expect(entries()).toEqual([SERIAL_ENTRY, USB_ENTRY]);
    // The menu is a MenuSvg, as the menus of the lab are: a MenuSvg adds this class
    // to its node, and a plain Lumino menu does not.
    expect(
      document.body
        .querySelector('.lm-Menu')!
        .classList.contains('jp-ThemedContainer')
    ).toBe(true);
    expect(all.serial.dialogs).toEqual([]);
    expect(all.usb.dialogs).toEqual([]);

    pick(CONNECT_SERIAL);
    await tick();

    expect(menuOpen()).toBe(false);
    expect(all.serial.dialogs).toEqual([null]);
    expect(all.usb.dialogs).toEqual([]);

    plus(all).click();
    pick(CONNECT_USB);
    await tick();

    expect(all.serial.dialogs).toEqual([null]);
    expect(all.usb.dialogs).toEqual([{ filters: [] }]);
    const rows = all.panel.node.querySelectorAll<HTMLElement>('[data-device]');
    expect(
      Array.from(rows, row => [row.dataset.device, row.dataset.state])
    ).toEqual([
      [UNO_NAME, 'attached'],
      [PROBE_NAME, 'attached']
    ]);
    expect(notifications()).toEqual([]);
  });

  it.each([
    ['serial', SERIAL_ENTRY, CONNECT_SERIAL, CONNECT_USB],
    ['usb', USB_ENTRY, CONNECT_USB, CONNECT_SERIAL]
  ] as const)(
    'ACC-PANEL-154 with only the %s interface the plus menu has the one entry of that interface and it opens the dialog, and the command of the absent interface is still registered, enabled and in the palette, and raises the notification that names HTTPS and localhost',
    async (only, entry, present, absent) => {
      const all = await lab({ interfaces: [only] });

      expect(plus(all).disabled).toBe(false);
      plus(all).click();
      expect(entries()).toEqual([entry]);
      expect(
        document.body.querySelector(`li.lm-Menu-item[data-command="${absent}"]`)
      ).toBeNull();

      pick(present);
      await tick();
      expect(menuOpen()).toBe(false);
      expect(all[only].dialogs).toHaveLength(1);
      expect(notifications()).toEqual([]);

      expect(offered(all)).toEqual([
        [true, true, true],
        [true, true, true]
      ]);
      await all.commands.execute(absent);
      await tick();
      expect(notifications()).toHaveLength(1);
      expect(notifications()[0][0]).toMatch(
        /^No device was attached: .*HTTPS.*localhost/
      );
      expect(notifications()[0][1]).toBe('error');
    }
  );

  it('ACC-PANEL-154 with neither browser interface the plus icon is disabled and opens no menu, the panel says that both interfaces need HTTPS or localhost, and both connect commands are still registered, enabled and in the palette', async () => {
    const all = await lab({ interfaces: [] });

    expect(plus(all).disabled).toBe(true);
    plus(all).click();
    expect(menuOpen()).toBe(false);
    expect(
      all.panel.node.querySelector('[data-field="absent"]')!.textContent
    ).toBe('Web Serial and WebUSB need HTTPS or localhost, in Chrome or Edge');
    expect(offered(all)).toEqual([
      [true, true, true],
      [true, true, true]
    ]);
    expect(notifications()).toEqual([]);
  });
});

describe('plugin: a grant dialog that gives no device', () => {
  it('ACC-PANEL-72 a port dialog the browser refuses for lack of a user gesture raises a notification that says to use the plus icon or Grant', async () => {
    const all = await lab();
    all.serial.dialog = NO_GESTURE;

    await all.commands.execute(CONNECT_SERIAL);
    await tick();

    expect(notifications()).toEqual([
      [
        `A device dialog opens only after a click. Use the plus icon or Grant in the Devices panel (if no sidebar has it: ${VIEW_ITEM}).`,
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
        `Use the plus icon or Grant in the Devices panel (if no sidebar has it: ${VIEW_ITEM}).`
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

  it('ACC-PANEL-154 a connect command in a browser without the device interfaces raises a notification that names HTTPS and localhost', async () => {
    const all = await lab({ interfaces: [] });

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

  it('ACC-SEC-93 each connect command, each entry of the plus menu, each Grant button and each Grant action of a notification opens one grant dialog', async () => {
    const all = await lab();
    await request(all, PROBE_REQUEST, PORT_REQUEST);

    await all.commands.execute(CONNECT_SERIAL);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([1, 0]);
    await all.commands.execute(CONNECT_USB);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([1, 1]);

    // The plus icon opens its menu and no dialog.
    plus(all).click();
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([1, 1]);
    pick(CONNECT_SERIAL);
    expect([all.serial.dialogs.length, all.usb.dialogs.length]).toEqual([2, 1]);
    plus(all).click();
    pick(CONNECT_USB);
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
  /** The command line of the serial terminal on a port, in words. */
  const terminalOn = (name: string): string[] => [
    'jupyterlab-device',
    'terminal',
    name
  ];

  it('ACC-TERM-79 with no attached port the command raises a notification and opens no lab terminal', async () => {
    const all = await lab();

    await all.commands.execute(OPEN_TERMINAL);
    await all.commands.execute(OPEN_TERMINAL, { name: UNO_NAME });

    const message = `No serial port is attached. Add a serial port in the Devices panel first (if no sidebar has the panel: ${VIEW_ITEM}).`;
    expect(notifications()).toEqual([
      [message, 'warning'],
      [message, 'warning']
    ]);
    expect(all.launch).not.toHaveBeenCalled();
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
    expect(all.launch).not.toHaveBeenCalled();
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
    expect(all.launch).not.toHaveBeenCalled();
    expect(all.newTerminal).not.toHaveBeenCalled();
  });

  it('ACC-TERM-148 with one attached port the command calls basic-terminal:launch with the words jupyterlab-device terminal and the name of that port, and asks nothing', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await all.commands.execute(OPEN_TERMINAL);

    expect(all.launch).toHaveBeenCalledTimes(1);
    expect(launchedLines(all)).toEqual([terminalOn(UNO_NAME)]);
    // No terminal with a shell is opened, so no line is typed.
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  it('ACC-TERM-239-SERIAL-TAB the serial terminal tab is titled Serial Terminal with the device icon and the caption of the port, and the device shell tab keeps its own title', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await all.commands.execute(OPEN_TERMINAL);

    expect(all.launchWidgets).toHaveLength(1);
    const [serial] = all.launchWidgets;
    expect(serial.title.label).toBe('Serial Terminal');
    expect(serial.title.icon).toBe(deviceIcon);
    expect(serial.title.caption).toBe(`Serial terminal on ${UNO_NAME}`);

    // The Terminal widget writes its own title when the launch resolves and on the
    // title changes of xterm; the plugin puts the identity of the tab back.
    serial.title.label = 'Terminal 1';
    serial.title.icon = { name: 'terminal' };
    serial.title.changed.emit();
    expect(serial.title.label).toBe('Serial Terminal');
    expect(serial.title.icon).toBe(deviceIcon);

    await all.commands.execute(START_RUN);

    expect(all.launchWidgets).toHaveLength(2);
    expect(all.launchWidgets[1].title).toEqual(LAUNCH_TITLE);
  });

  it('ACC-TERM-148 with several attached ports the command asks which one and launches the words with the chosen port, and a closed question launches nothing', async () => {
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
    expect(launchedLines(all)).toEqual([terminalOn(NANO_NAME)]);

    getItem.mockResolvedValueOnce({ button: { accept: false }, value: null });
    await all.commands.execute(OPEN_TERMINAL);

    expect(all.launch).toHaveBeenCalledTimes(1);
    expect(all.newTerminal).not.toHaveBeenCalled();
  });

  it('ACC-TERM-148 the Terminal button of a row and the argument name launch the words with that port without a question', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO), new SimSerialPort(NANO)]
    });

    button(
      all,
      `[data-device="${NANO_NAME}"] [data-action="terminal"]`
    ).click();
    await tick();
    await all.commands.execute(OPEN_TERMINAL, { name: UNO_NAME });

    expect(launchedLines(all)).toEqual([
      terminalOn(NANO_NAME),
      terminalOn(UNO_NAME)
    ]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('DEF-SERIAL-20 the serial terminal command, the Terminal button of a row and the command Device Shell each call basic-terminal:launch with shutdownOnClose true, so that closing the tab ends the terminal session and its program', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await all.commands.execute(OPEN_TERMINAL);
    button(all, `[data-device="${UNO_NAME}"] [data-action="terminal"]`).click();
    await tick();
    await all.commands.execute(START_RUN);

    const calls = all.launch.mock.calls as unknown as Array<
      [{ argv: string[]; shutdownOnClose: unknown }]
    >;
    expect(calls).toHaveLength(3);
    expect(calls.map(([args]) => args.shutdownOnClose)).toEqual([
      true,
      true,
      true
    ]);
    expect(calls.map(([args]) => args.argv.slice(3))).toEqual([
      terminalOn(UNO_NAME),
      terminalOn(UNO_NAME),
      ['jupyterlab-device', 'shell']
    ]);
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
    expect(all.launch).not.toHaveBeenCalled();
    expect(all.newTerminal).not.toHaveBeenCalled();
  });
});

describe('plugin: the device shell', () => {
  /** The command line of a device shell, in words. */
  const DEVICE_SHELL = ['jupyterlab-device', 'shell'];

  it('ACC-PANEL-147 the command Device Shell calls basic-terminal:launch with the words jupyterlab-device shell and no folder, with no device attached, and types no line into a terminal', async () => {
    const all = await lab();

    await all.commands.execute(START_RUN);

    expect(all.launch).toHaveBeenCalledTimes(1);
    expect(launchedLines(all)).toEqual([DEVICE_SHELL]);
    // No terminal with a shell is opened, so no line is typed.
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-147 the Start button of the runs section launches the same words', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    await tick();

    expect(all.launch).toHaveBeenCalledTimes(1);
    expect(launchedLines(all)).toEqual([DEVICE_SHELL]);
    expect(all.newTerminal).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  it('ACC-PANEL-147 the command is in the palette under Devices and in the Devices menu, and the menu entry launches the device shell', async () => {
    const all = await lab({ settings: { showMenu: true } });
    const [menu] = all.mainMenu.addMenu.mock.calls[0] as [Menu];

    expect(all.commands.label(START_RUN)).toBe('Device Shell');
    expect(all.palette.addItem.mock.calls).toContainEqual([
      { command: START_RUN, category: 'Devices' }
    ]);
    expect(menu.items.map(item => item.command)).toContain(START_RUN);

    const entry = menu.items.find(item => item.command === START_RUN)!;
    await all.commands.execute(entry.command, entry.args);
    expect(launchedLines(all)).toEqual([DEVICE_SHELL]);
  });

  it('ACC-TERM-111 where the server offers no terminals the command Device Shell and the Start button show the command line to run and launch nothing', async () => {
    const all = await lab({ terminals: false });

    await all.commands.execute(START_RUN);
    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    await tick();

    const text =
      'This server offers no terminals. Run this command in a shell of the container: jupyterlab-device shell';
    expect(emit.mock.calls).toEqual([
      [text, 'info', { autoClose: false }],
      [text, 'info', { autoClose: false }]
    ]);
    expect(all.launch).not.toHaveBeenCalled();
    expect(all.newTerminal).not.toHaveBeenCalled();
  });
});

describe('plugin: how a command line is started in a lab terminal', () => {
  // Node's own module; the project has no type package for it.
  const { spawn } = jest.requireActual('child_process') as {
    spawn(
      program: string,
      words: string[]
    ): {
      exitCode: number | null;
      kill(): void;
      stdin: { write(text: string): void };
      stdout: { on(event: 'data', listener: (chunk: unknown) => void): void };
      on(event: 'close', listener: (status: number | null) => void): void;
    };
  };

  const PROMPT = 'Press Enter to close this terminal. ';

  /** Every bash that a test started; a test that fails must leave none running. */
  const started: Array<{ kill(): void }> = [];
  afterEach(() => {
    for (const child of started.splice(0)) {
      child.kill();
    }
  });

  /** The script that the plugin gives to bash: the third word of a launch. */
  async function launchScript(): Promise<string> {
    const all = await lab();
    await all.commands.execute(START_RUN);
    return launches(all)[0][2];
  }

  /**
   * Run a script with a command line as the basic terminal extension starts them:
   * `/bin/bash -c <script> <command line>`. The standard input stays open, as that of
   * a terminal does. The tests that call this run with the real timers.
   */
  function bash(script: string, ...commandLine: string[]) {
    const child = spawn('/bin/bash', ['-c', script, ...commandLine]);
    started.push(child);
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
    });
    return {
      child,
      output: (): string => output,
      /** Resolves with the exit status when the script has ended. */
      ended: new Promise<number | null>(resolve => child.on('close', resolve)),
      /** Resolves when the output ends with the prompt. */
      prompted: (): Promise<void> =>
        new Promise(resolve => {
          const look = (): void => {
            if (output.endsWith(PROMPT)) {
              resolve();
            } else {
              setTimeout(look, 10);
            }
          };
          look();
        })
    };
  }

  const pause = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

  it('ACC-PANEL-149 both commands launch /bin/bash -c with the same script and their command line after it, and the script runs the command line, tests its status and the 5 seconds, prints the prompt and ends with the status', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await all.commands.execute(START_RUN);
    await all.commands.execute(OPEN_TERMINAL);

    const [shell, terminal] = launches(all);
    expect(shell).toEqual([
      '/bin/bash',
      '-c',
      shell[2],
      'jupyterlab-device',
      'shell'
    ]);
    expect(terminal).toEqual([
      '/bin/bash',
      '-c',
      shell[2],
      'jupyterlab-device',
      'terminal',
      UNO_NAME
    ]);
    const lines = shell[2].split('\n');
    // The command line is the words after the script.
    expect(lines[0]).toBe('"$0" "$@"');
    expect(lines[1]).toBe('status=$?');
    expect(shell[2]).toContain('[ "$status" -ne 0 ]');
    expect(shell[2]).toContain('[ "$SECONDS" -lt 5 ]');
    expect(shell[2]).toContain(`printf '${PROMPT}'`);
    expect(lines[lines.length - 1]).toBe('exit "$status"');
  });

  it('ACC-PANEL-149 run by bash: a command line that ends with status 3 at once has the prompt under its message, the script waits for one line and then ends with 3', async () => {
    const script = await launchScript();
    jest.useRealTimers();

    const run = bash(
      script,
      '/bin/sh',
      '-c',
      'echo "error: the device is held by another program"; exit 3'
    );
    await run.prompted();
    // The script waits: it has not ended, and it has printed nothing after the prompt.
    await pause(200);
    expect(run.child.exitCode).toBeNull();
    expect(run.output()).toBe(
      `error: the device is held by another program\n${PROMPT}`
    );

    run.child.stdin.write('\n');
    expect(await run.ended).toBe(3);
    expect(run.output()).toBe(
      `error: the device is held by another program\n${PROMPT}`
    );
  });

  it('ACC-PANEL-149 run by bash: a command line that ends with status 0 gets no prompt, and the script ends with 0 without a line of input', async () => {
    const script = await launchScript();
    jest.useRealTimers();

    const run = bash(script, '/bin/sh', '-c', 'echo "bye"; exit 0');

    // The standard input is open and gets no line: a script that waited would not end.
    expect(await run.ended).toBe(0);
    expect(run.output()).toBe('bye\n');
  });

  it('ACC-PANEL-149 run by bash: a command line that ends with status 3 when the script has run for 5 seconds gets no prompt, and one that ends at 4 seconds gets it', async () => {
    const script = await launchScript();
    jest.useRealTimers();

    // Bash counts SECONDS on from a value that a script gives it.
    const late = bash(`SECONDS=5\n${script}`, '/bin/sh', '-c', 'exit 3');
    expect(await late.ended).toBe(3);
    expect(late.output()).toBe('');

    const early = bash(`SECONDS=4\n${script}`, '/bin/sh', '-c', 'exit 3');
    await early.prompted();
    early.child.stdin.write('\n');
    expect(await early.ended).toBe(3);
    expect(early.output()).toBe(PROMPT);
  });

  it('ACC-PANEL-150 in a lab without the command basic-terminal:launch the commands Device Shell and Serial Terminal and their buttons open nothing, and each shows its command line and the name jupyterlab_basic_terminal_extension', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      launcher: false
    });
    expect(all.commands.hasCommand(BASIC_TERMINAL_LAUNCH)).toBe(false);

    await all.commands.execute(START_RUN);
    await all.commands.execute(OPEN_TERMINAL);
    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    button(all, `[data-device="${UNO_NAME}"] [data-action="terminal"]`).click();
    await tick();

    const shell =
      'The lab has no jupyterlab_basic_terminal_extension. Run in a shell of the container: jupyterlab-device shell';
    const terminal = `The lab has no jupyterlab_basic_terminal_extension. Run in a shell of the container: jupyterlab-device terminal ${UNO_NAME}`;
    expect(emit.mock.calls).toEqual([
      [shell, 'warning', { autoClose: false }],
      [terminal, 'warning', { autoClose: false }],
      [shell, 'warning', { autoClose: false }],
      [terminal, 'warning', { autoClose: false }]
    ]);
    // The lab cuts a notification after 140 characters.
    expect(terminal.length).toBeLessThanOrEqual(140);
    expect(all.launch).not.toHaveBeenCalled();
    expect(all.newTerminal).not.toHaveBeenCalled();
  });

  /** The fixed part of the notification of a launch that the command refused. */
  const NOT_STARTED = 'The terminal did not start: ';

  /** The notification of a launch that the command refused for this reason, as the plugin raises it. */
  const notStarted = (reason: string): unknown[] => [
    `${NOT_STARTED}${reason}`,
    'error',
    { autoClose: false }
  ];

  it('ACC-PANEL-161 when basic-terminal:launch rejects, the Start button, the Terminal button of a serial row and the two lab commands each raise one error notification that says the terminal did not start and holds the reason, and the commands end without an error', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    // An example of a refusal: the terminal ended before the lab displayed it.
    const reason =
      'basic-terminal:launch: terminal "3" exited before it could be displayed';
    all.launch.mockRejectedValue(new Error(reason));

    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    await tick();
    expect(emit.mock.calls).toEqual([notStarted(reason)]);

    button(all, `[data-device="${UNO_NAME}"] [data-action="terminal"]`).click();
    await tick();
    expect(emit.mock.calls).toEqual([notStarted(reason), notStarted(reason)]);

    await expect(all.commands.execute(START_RUN)).resolves.toBeUndefined();
    await expect(all.commands.execute(OPEN_TERMINAL)).resolves.toBeUndefined();
    expect(emit.mock.calls).toEqual([
      notStarted(reason),
      notStarted(reason),
      notStarted(reason),
      notStarted(reason)
    ]);
    // Each of the four was a launch that the command refused.
    expect(launchedLines(all)).toEqual([
      ['jupyterlab-device', 'shell'],
      ['jupyterlab-device', 'terminal', UNO_NAME],
      ['jupyterlab-device', 'shell'],
      ['jupyterlab-device', 'terminal', UNO_NAME]
    ]);
    expect(all.newTerminal).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-161 a rejection that is no Error gives its string as the reason', async () => {
    const all = await lab();
    all.launch.mockRejectedValue('the terminal ended before its display');

    await all.commands.execute(START_RUN);

    expect(emit.mock.calls).toEqual([
      notStarted('the terminal ended before its display')
    ]);
  });

  it('ACC-PANEL-161 a reason of 300 characters gives a text of 140 characters that ends with three dots, and a text of exactly 140 characters is not cut', async () => {
    const all = await lab();
    // Digits, so that the test sees which part of the reason a text keeps.
    const long = Array.from({ length: 300 }, (_, index) => index % 10).join('');
    expect(NOT_STARTED).toHaveLength(28);

    // 28 characters of the fixed part and 112 of the reason are 140; one more is 141.
    for (const reason of [long, long.slice(0, 112), long.slice(0, 113)]) {
      all.launch.mockRejectedValue(new Error(reason));
      await all.commands.execute(START_RUN);
    }

    const texts = notifications().map(([text]) => text);
    expect(texts).toEqual([
      `${NOT_STARTED}${long.slice(0, 109)}...`,
      `${NOT_STARTED}${long.slice(0, 112)}`,
      `${NOT_STARTED}${long.slice(0, 109)}...`
    ]);
    // The lab cuts a notification after 140 characters.
    expect(texts.map(text => text.length)).toEqual([140, 140, 140]);
    expect(notifications().map(([, type]) => type)).toEqual([
      'error',
      'error',
      'error'
    ]);
  });

  it('ACC-PANEL-161 a launch that succeeds raises no notification', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    button(all, `[data-device="${UNO_NAME}"] [data-action="terminal"]`).click();
    await tick();
    await all.commands.execute(START_RUN);
    await all.commands.execute(OPEN_TERMINAL);

    expect(all.launch).toHaveBeenCalledTimes(4);
    expect(notifications()).toEqual([]);
  });
});

describe('plugin: the Info dialog of the runs section', () => {
  // Node's own modules; the project has no type package for them.
  const fs = jest.requireActual('fs') as {
    readFileSync(file: string, encoding: 'utf8'): string;
  };
  const path = jest.requireActual('path') as {
    resolve(...parts: string[]): string;
  };

  /** The four example lines of docs/design.md, word for word. */
  const EXAMPLES: Record<string, string> = {
    avrdude:
      'avrdude -c arduino -p atmega328p -b 115200 -P <path> -U flash:w:firmware.hex:i',
    stm32flash: 'stm32flash -b 115200 -w firmware.bin -v -g 0x0 <path>',
    esptool: 'esptool --port <path> write-flash 0x0 firmware.bin',
    pio: 'pio run -t upload --upload-port <path>'
  };
  /** The example path that the README has in the command line of each tool. */
  const README_PATHS: Record<string, string> = {
    avrdude: '/run/devices/tty-2341-0043',
    stm32flash: '/run/devices/tty-0403-6001',
    esptool: '/run/devices/tty-10c4-ea60',
    pio: '/run/devices/tty-2341-0043'
  };
  /** What a README line has in front of a tool that needs the shim. */
  const RUN_PREFIX = /^jupyterlab-device run (?:--device \S+ )?-- /;

  /** Make the server list one run, so that the panel offers Info, and click Info. */
  async function openInfo(all: ILab): Promise<void> {
    all.server.running.splice(0, all.server.running.length, SHELL_RUN);
    all.server.pushRuns();
    await tick();
    const info = button(all, '[data-section="runs"] [data-action="run-info"]');
    expect(info.hidden).toBe(false);
    info.click();
    await tick();
  }

  /** The options of the dialog that the plugin opened last. A widget is never given to `expect`. */
  const opened = (): {
    title: unknown;
    buttons: unknown;
    body: HTMLElement;
  } => {
    const [options] = dialog.mock.calls[dialog.mock.calls.length - 1];
    return {
      title: options.title,
      buttons: options.buttons,
      body: (options.body as Widget).node
    };
  };

  /** The devices the dialog lists: the name of each, and its path when it shows one. */
  const listed = (body: HTMLElement): Array<Array<string | null>> =>
    Array.from(
      body.querySelectorAll<HTMLElement>('[data-info-device]'),
      node => [
        node.dataset.infoDevice!,
        node.querySelector('[data-field="name"]')!.textContent,
        node.querySelector('[data-field="path"]')?.textContent ?? null
      ]
    );

  /** The example lines of the dialog, by the name of the tool. */
  const examples = (body: HTMLElement): Record<string, string | null> => {
    const lines: Record<string, string | null> = {};
    body.querySelectorAll<HTMLElement>('[data-example]').forEach(node => {
      lines[node.dataset.example!] = node.textContent;
    });
    return lines;
  };

  /** `EXAMPLES` with a path in place of the placeholder. */
  const examplesWith = (devicePath: string): Record<string, string> => {
    const lines: Record<string, string> = {};
    for (const [tool, line] of Object.entries(EXAMPLES)) {
      lines[tool] = line.replace('<path>', devicePath);
    }
    return lines;
  };

  it('ACC-PANEL-134 the Info button opens one dialog of the lab with the title How to connect a tool and the one button Close', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await openInfo(all);

    expect(dialog.mock.calls.length).toBe(1);
    expect(opened().title).toBe('How to connect a tool');
    expect(opened().buttons).toEqual([{ kind: 'ok', label: 'Close' }]);
    expect(opened().body.classList.contains('jp-DeviceBridgeInfo')).toBe(true);
    expect(notifications()).toEqual([]);
  });

  it('ACC-PANEL-134 the dialog lists each attached serial device with its path and each attached USB device by name, and the example lines carry the path of the first attached serial device', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO), new SimSerialPort(NANO)],
      devices: [new SimUsbDevice()]
    });

    await openInfo(all);

    expect(listed(opened().body)).toEqual([
      [UNO_NAME, UNO_NAME, `${DEVICE_DIR}/${UNO_NAME}`],
      [NANO_NAME, NANO_NAME, `${DEVICE_DIR}/${NANO_NAME}`],
      [PROBE_NAME, PROBE_NAME, null]
    ]);
    expect(examples(opened().body)).toEqual(
      examplesWith(`${DEVICE_DIR}/${UNO_NAME}`)
    );

    // A detached device is not listed, and the next attached serial device gives the path.
    for (const name of [UNO_NAME, PROBE_NAME]) {
      button(all, `[data-device="${name}"] [data-action="detach"]`).click();
    }
    await tick();
    await openInfo(all);

    expect(dialog.mock.calls.length).toBe(2);
    expect(listed(opened().body)).toEqual([
      [NANO_NAME, NANO_NAME, `${DEVICE_DIR}/${NANO_NAME}`]
    ]);
    expect(examples(opened().body)).toEqual(
      examplesWith(`${DEVICE_DIR}/${NANO_NAME}`)
    );
  });

  it('ACC-PANEL-134 without an attached serial device the dialog says that no device is attached, and the three example lines are those of the design with <path>', async () => {
    const all = await lab();

    await openInfo(all);

    expect(listed(opened().body)).toEqual([]);
    expect(opened().body.textContent).toContain('No device is attached.');
    expect(examples(opened().body)).toEqual(EXAMPLES);

    // A USB device has no path: the lines keep the placeholder.
    all.usb.dialog = new SimUsbDevice();
    await all.commands.execute(CONNECT_USB);
    await tick();
    await openInfo(all);

    expect(listed(opened().body)).toEqual([[PROBE_NAME, PROBE_NAME, null]]);
    expect(opened().body.textContent).not.toContain('No device is attached.');
    expect(examples(opened().body)).toEqual(EXAMPLES);
  });

  it('ACC-PANEL-134 each example line of the dialog, with the example path of the README in place of <path>, is a line of a bash block of the README section Working with an AI agent, without the prefix jupyterlab-device run', async () => {
    const readme = fs.readFileSync(
      path.resolve(expect.getState().testPath!, '../../../README.md'),
      'utf8'
    );
    const section = readme
      .split(/^## /m)
      .find(part => part.startsWith('Working with an AI agent\n'));
    expect(section).toBeDefined();
    const commandLines: string[] = [];
    const block = /^```bash\n([\s\S]*?)^```$/gm;
    for (
      let found = block.exec(section!);
      found;
      found = block.exec(section!)
    ) {
      commandLines.push(
        ...found[1].split('\n').map(line => line.replace(RUN_PREFIX, ''))
      );
    }
    const all = await lab();

    await openInfo(all);
    const shown = examples(opened().body);

    expect(Object.keys(shown)).toEqual([
      'avrdude',
      'stm32flash',
      'esptool',
      'pio'
    ]);
    for (const [tool, line] of Object.entries(shown)) {
      // The placeholder stands once in a line, where the README has its example path.
      expect(line!.split('<path>')).toHaveLength(2);
      expect(commandLines).toContain(
        line!.replace('<path>', README_PATHS[tool])
      );
    }
  });

  it('ACC-PANEL-134 the dialog says that the lines are typed in a device shell and that no line was run against a board', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    await openInfo(all);

    const note = opened().body.querySelector('[data-field="note"]')!;
    expect(note.textContent).toContain('Type a line in a device shell.');
    expect(note.textContent).toContain('No line was run against a board.');
  });

  it('ACC-PANEL-140 ACC-PANEL-175 the note of the Info dialog names a device shell and the section Device shells, word for word', async () => {
    const all = await lab();

    await openInfo(all);

    expect(
      opened().body.querySelector('[data-field="note"]')!.textContent
    ).toBe(
      'Type a line in a device shell. The button Start of the section Device shells opens one. No line was run against a board.'
    );
  });
});

describe('plugin: no text of the lab holds the word shim', () => {
  // Node's own modules; the project has no type package for them.
  const fs = jest.requireActual('fs') as {
    readFileSync(file: string, encoding: 'utf8'): string;
  };
  const path = jest.requireActual('path') as {
    resolve(...parts: string[]): string;
  };

  /** Every text an element shows: its text content, and each title, label for a screen reader and placeholder in it. */
  const textsOf = (root: HTMLElement): string[] => {
    const texts = [root.textContent || ''];
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      root
        .querySelectorAll(`[${attribute}]`)
        .forEach(node => texts.push(node.getAttribute(attribute)!));
    }
    return texts;
  };

  it('ACC-PANEL-140 the command start-run is labelled Device Shell, in the palette and in the Devices menu, and its caption says what a device shell is', async () => {
    const all = await lab({ settings: { showMenu: true } });
    const [menu] = all.mainMenu.addMenu.mock.calls[0] as [Menu];

    expect(all.commands.label(START_RUN)).toBe('Device Shell');
    expect(all.commands.caption(START_RUN)).toBe(
      'Open a device shell: a lab terminal in which tools control the lines of the serial ports'
    );
    expect(menu.items.find(item => item.command === START_RUN)!.label).toBe(
      'Device Shell'
    );
    // The command id stays, and the command starts a device shell.
    await all.commands.execute(START_RUN);
    expect(launchedLines(all)).toEqual([['jupyterlab-device', 'shell']]);
  });

  it('ACC-PANEL-140 no text that the panel, the Info dialog, the commands, the Devices menu and the notification of a server without terminals show holds the word shim, in any letter case', async () => {
    // A server without terminals: the commands that open a terminal raise a notification.
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      devices: [new SimUsbDevice()],
      settings: { showPanel: true, showMenu: true },
      terminals: false
    });
    const texts: string[] = [];

    // The panel without a run, then with one.
    texts.push(...textsOf(all.panel.node), all.panel.title.caption);
    all.server.running.push(SHELL_RUN);
    all.server.pushRuns();
    await tick();
    texts.push(...textsOf(all.panel.node));

    // The Info dialog.
    button(all, '[data-section="runs"] [data-action="run-info"]').click();
    await tick();
    const [options] = dialog.mock.calls[0] as [
      { title: string; body: Widget; buttons: Array<{ label: string }> }
    ];
    texts.push(
      options.title,
      ...options.buttons.map(shown => shown.label),
      ...textsOf(options.body.node)
    );

    // The commands, as the palette and the Devices menu show them.
    const ids = all.commands
      .listCommands()
      .filter(id => id.startsWith('device-bridge:'));
    for (const id of ids) {
      texts.push(all.commands.label(id), all.commands.caption(id));
    }
    const [menu] = all.mainMenu.addMenu.mock.calls[0] as [Menu];
    texts.push(menu.title.label, ...menu.items.map(item => item.label));

    // The notifications of the two commands that open a terminal.
    button(all, '[data-section="runs"] [data-action="start-run"]').click();
    await all.commands.execute(OPEN_TERMINAL);
    await tick();
    texts.push(...notifications().map(([text]) => text));

    // The collection holds the texts of each part.
    expect(ids).toHaveLength(5);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Devices',
        'How to connect a tool',
        'Close',
        'Device Shell',
        'Open a device shell',
        'This server offers no terminals. Run this command in a shell of the container: jupyterlab-device shell'
      ])
    );
    expect(texts.join('\n')).toContain('Device shells');
    expect(texts.join('\n')).toContain('No line was run against a board.');
    expect(texts.join('\n')).toContain('pid 4242');

    for (const text of texts) {
      expect(text).not.toMatch(/shim/i);
    }
  });

  it('ACC-PANEL-140 no text literal in the source of the plugin, the panel, the status bar item and the model holds the word shim', () => {
    const directory = path.resolve(expect.getState().testPath!, '../..');
    for (const file of ['index.ts', 'panel.ts', 'status.ts', 'model.ts']) {
      const code = fs
        .readFileSync(path.resolve(directory, file), 'utf8')
        // Without comments: a comment may hold the word and is no text for the user.
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      const literals =
        code.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];

      expect(literals.length).toBeGreaterThan(10);
      for (const literal of literals) {
        expect(literal).not.toMatch(/shim/i);
      }
    }
  });
});

describe('plugin: the Devices menu', () => {
  const menus = (all: ILab): Menu[] =>
    all.mainMenu.addMenu.mock.calls.map(([menu]) => menu);

  it('ACC-PANEL-68 with the default settings the lab gets no Devices menu', async () => {
    const all = await lab({ settings: {} });

    expect(menus(all)).toEqual([]);
  });

  it('ACC-PANEL-69 with showMenu true the lab gets a Devices menu with the five commands', async () => {
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
      START_RUN,
      SHOW_PANEL
    ]);
    expect(menu.items.map(item => item.label)).toEqual([
      'Connect Serial Port',
      'Connect USB Device',
      'Serial Terminal',
      'Device Shell',
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
    expect(menus(all)[1].items).toHaveLength(5);
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

describe('plugin: the help tab', () => {
  /** The help file, as the contents API reports it. */
  const file = (content: string): { content: string } => ({ content });

  /** What the plugin wrote to the help file, as the contents API recorded it. */
  const saves = (all: ILab): unknown[][] => all.contents.save.mock.calls;

  /** The widgets of the main area that show the help file. */
  const helpTabs = (all: ILab): Widget[] =>
    all.main.widgets.filter(
      widget =>
        (widget as Widget & { content?: { context?: { path?: string } } })
          .content?.context?.path === HELP_PATH
    );

  it('ACC-PANEL-227 a missing help file is written and the lab Markdown viewer opens it in one tab', async () => {
    const all = await lab();

    button(all, '[data-action="settings-help"]').click();
    await tick();

    expect(all.contents.get.mock.calls).toEqual([
      [HELP_PATH, { content: true }]
    ]);
    expect(saves(all)).toEqual([
      [HELP_PATH, { type: 'file', format: 'text', content: HELP_MARKDOWN }]
    ]);
    expect(all.markdown.mock.calls).toEqual([[{ path: HELP_PATH }]]);
    expect(all.main.widgets).toHaveLength(1);
    const [tab] = all.main.widgets;
    // The title of a document tab is the name of its file, so the tab is titled
    // Device Bridge Help. The stand-in of the document manager gives the tab an id
    // of its own.
    expect(tab.title.label).toBe('Device Bridge Help');
    expect(tab.id).toBe('document-manager-1');
    expect(helpTabs(all)).toEqual([tab]);
  });

  it('ACC-PANEL-227 an unchanged help file is not written again', async () => {
    const all = await lab();
    all.contents.get.mockResolvedValueOnce(file(HELP_MARKDOWN));

    button(all, '[data-action="settings-help"]').click();
    await tick();

    expect(all.contents.get).toHaveBeenCalledTimes(1);
    expect(all.contents.save).not.toHaveBeenCalled();
    expect(all.markdown.mock.calls).toEqual([[{ path: HELP_PATH }]]);
    expect(all.main.widgets).toHaveLength(1);
  });

  it('ACC-PANEL-227 a help file that holds other text is written with the help text', async () => {
    const all = await lab();
    all.contents.get.mockResolvedValueOnce(file('An older help text.'));

    button(all, '[data-action="settings-help"]').click();
    await tick();

    expect(saves(all)).toEqual([
      [HELP_PATH, { type: 'file', format: 'text', content: HELP_MARKDOWN }]
    ]);
    expect(all.markdown.mock.calls).toEqual([[{ path: HELP_PATH }]]);
  });

  it('ACC-PANEL-227 a second click activates the open help tab and opens neither a second tab nor a second file', async () => {
    const all = await lab();
    const help = button(all, '[data-action="settings-help"]');

    help.click();
    await tick();
    const [tab] = all.main.widgets;

    help.click();
    await tick();

    expect(all.main.widgets).toHaveLength(1);
    expect(all.main.widgets[0]).toBe(tab);
    expect(all.shell.activateById.mock.calls).toEqual([[tab.id]]);
    expect(all.markdown).toHaveBeenCalledTimes(1);
    expect(all.contents.get).toHaveBeenCalledTimes(1);
    expect(all.contents.save).toHaveBeenCalledTimes(1);
  });

  it('ACC-PANEL-227 a widget without an id gets the help id, and the id that the lab gave the viewer is kept', async () => {
    const withoutId = await lab({ viewerId: '' });
    button(withoutId, '[data-action="settings-help"]').click();
    await tick();
    expect(withoutId.main.widgets[0].id).toBe(HELP_ID);

    const withId = await lab();
    button(withId, '[data-action="settings-help"]').click();
    await tick();
    expect(withId.main.widgets[0].id).toBe('document-manager-1');
  });

  it('ACC-PANEL-227 a contents call that fails raises one error notification, opens no tab and leaves no rejected promise', async () => {
    const all = await lab();
    all.contents.get.mockRejectedValueOnce(
      new Error('The contents server is down.')
    );

    button(all, '[data-action="settings-help"]').click();
    await tick();
    // Node reports a rejected promise without a handler when a task of the event loop
    // ends. The test lives through one task, so a rejected promise would appear here.
    await new Promise(resolve =>
      jest.requireActual('timers').setImmediate(resolve)
    );

    expect(notifications()).toEqual([
      [
        'The help document could not be opened: The contents server is down.',
        'error'
      ]
    ]);
    expect(all.markdown).not.toHaveBeenCalled();
    expect(all.main.widgets).toHaveLength(0);

    // A save that fails is the same failure: no tab, one error notification.
    all.contents.get.mockRejectedValueOnce(
      new ServerConnection.ResponseError({
        status: 404,
        statusText: 'Not Found'
      } as unknown as Response)
    );
    all.contents.save.mockRejectedValueOnce(new Error('Permission denied'));
    button(all, '[data-action="settings-help"]').click();
    await tick();

    expect(notifications()).toEqual([
      [
        'The help document could not be opened: The contents server is down.',
        'error'
      ],
      ['The help document could not be opened: Permission denied', 'error']
    ]);
    expect(all.markdown).not.toHaveBeenCalled();
    expect(all.main.widgets).toHaveLength(0);
  });
});
