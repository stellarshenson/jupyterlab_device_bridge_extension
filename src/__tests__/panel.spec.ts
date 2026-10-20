/**
 * The Devices panel against the real model, the real worker function, simulated
 * devices and a simulated server.
 *
 * The tests read and click the panel through the hooks listed at the top of
 * `src/panel.ts`, as the functional tests do in a browser. The lab packages that Jest
 * cannot load are replaced: the notifications and the dialogs by recorders, the icon of
 * the panel by its SVG text. The plus icon and its menu are those of the lab.
 */

import { Clipboard, Notification, showDialog } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { MenuSvg } from '@jupyterlab/ui-components';

import { CommandRegistry } from '@lumino/commands';
import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';

import { DeviceBridgeModel } from '../model';
import { HELP_MARKDOWN } from '../help';
import {
  ARM_DELAY_MS,
  COPIED_MS,
  DeviceBridgePanel,
  RUN_VISIBLE_MS,
  formatBytes,
  requestedDevice
} from '../panel';
import type {
  IDeviceRequest,
  IRunRecord,
  ISerialConfig,
  ISerialRecord,
  ISerialSettingsChange,
  ISettingsConfig
} from '../protocol';
import { createWorker, workerMain } from '../worker';
import {
  BULK_ENDPOINT,
  SimScope,
  SimSerial,
  SimSerialPort,
  SimServer,
  SimUsb,
  SimUsbDevice,
  toBase64
} from './sim';

jest.mock('@jupyterlab/apputils', () => {
  interface IButtonOptions {
    label?: string;
    accept?: boolean;
    displayType?: string;
    className?: string;
  }
  // What Dialog.createButton does in the lab: the accept flag defaults to true and
  // the display type to default. The tests make the classes from these fields.
  const createButton = (button: IButtonOptions = {}): object => {
    button.accept = button.accept !== false;
    const label = button.label || (button.accept ? 'OK' : 'Cancel');
    return {
      ariaLabel: label,
      label,
      iconClass: '',
      iconLabel: '',
      caption: '',
      className: button.className || '',
      accept: button.accept,
      actions: [],
      displayType: button.displayType || 'default'
    };
  };
  return {
    // A button of a dialog is the fields the real Dialog gives it.
    Dialog: {
      createButton,
      cancelButton: (options: IButtonOptions = {}) => {
        options.accept = false;
        return createButton(options);
      },
      okButton: (options: IButtonOptions = {}) => {
        options.accept = true;
        return createButton(options);
      },
      warnButton: (options: IButtonOptions = {}) => {
        options.displayType = 'warn';
        return createButton(options);
      }
    },
    Clipboard: { copyToSystem: jest.fn() },
    Notification: { emit: jest.fn() },
    showDialog: jest.fn()
  };
});
jest.mock('@jupyterlab/ui-components', () => ({
  LabIcon: class {
    constructor(readonly options: { name: string; svgstr: string }) {}
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

const UNO = { usbVendorId: 0x2341, usbProductId: 0x0043 };
const UNO_KEY = 's:2341:0043:0';
const UNO_NAME = 'tty-2341-0043';
const PROBE_NAME = 'usb-0d28-0204';
const PROBE_REQUEST: IDeviceRequest = {
  id: 'request-1',
  kind: 'usb',
  vendorId: 0x0d28,
  productId: 0x0204,
  reason: 'flash the board',
  program: 'pyocd'
};
/** A terminal shell that runs with the shim, and an upload that names its device. */
const SHELL_RUN: IRunRecord = {
  pid: 4242,
  program: 'bash',
  command: '/bin/bash',
  device: null
};
const UPLOAD_RUN: IRunRecord = {
  pid: 4250,
  program: 'avrdude',
  command: `avrdude -c arduino -p atmega328p -b 115200 -P /run/devices/${UNO_NAME} -U flash:w:firmware.hex:i`,
  device: UNO_NAME
};
/** A serial port that another tab holds, as the server lists it. */
const HELD: ISerialRecord = {
  name: UNO_NAME,
  path: `/tmp/jupyterlab-device-1000/${UNO_NAME}`,
  state: 'attached',
  portState: 'open',
  tab: 'tab-2',
  holder: null,
  settings: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 },
  configured: {
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    onOpen: 'none'
  },
  config: null,
  configName: null,
  signals: {},
  rx: 0,
  tx: 0,
  vendorId: 0x2341,
  productId: 0x0043,
  error: null
};

interface ILab {
  server: SimServer;
  serial: SimSerial;
  usb: SimUsb;
  /** The body of every settings change the page sent to the server, in order. */
  changes: ISerialSettingsChange[];
  /** How the server answers a settings change; it accepts unless a test says otherwise. */
  answer: (change: ISerialSettingsChange) => Response;
  /** The bodies of the saved configs the page sent, in order. */
  savedConfigs: Array<{ name: string } & ISerialConfig>;
  /** The path of every DELETE the page sent, in order. */
  deleted: string[];
  /** The method and the path of every stop of a run the page sent to the server, in order. */
  stops: string[];
  /** How the server answers the stop of a run; with 204 unless a test says otherwise. */
  stopAnswer: () => Response;
  fetch: jest.Mock;
  model: DeviceBridgeModel;
  panel: DeviceBridgePanel;
  /** The menu that the panel got for its plus icon: the two connect commands. */
  addMenu: MenuSvg;
  /** Recorders: the two connect commands of the plus menu, then what the panel calls. */
  handlers: {
    connectSerial: jest.Mock;
    connectUsb: jest.Mock;
    grantRequest: jest.Mock;
    openTerminal: jest.Mock;
    startRun: jest.Mock;
    showRunInfo: jest.Mock;
    showHelp: jest.Mock;
  };
}

interface ILabOptions {
  ports?: SimSerialPort[];
  devices?: SimUsbDevice[];
  /** The device interfaces the browser has; both unless a test says otherwise. On plain http it has none. */
  interfaces?: Array<'serial' | 'usb'>;
  /** Runs before the model starts the worker. */
  prepare?: (server: SimServer) => void;
}

const emit = Notification.emit as jest.Mock;

/** Let every promise settle and advance the fake time by `ms`. */
const tick = (ms = 0): Promise<void> => jest.advanceTimersByTimeAsync(ms);

/** A button of a dialog, with the fields that the lab's Dialog.createButton sets. */
interface IDialogButton {
  label: string;
  accept: boolean;
  displayType: string;
  className: string;
}

/** A dialog of the lab that the panel opened and that is still open. */
interface IOpenDialog {
  title: string;
  body: Widget & { getValue?(): unknown };
  buttons: IDialogButton[];
  /** Close the dialog with the button of this label, as the lab does, and let the panel act. */
  close(label: string): Promise<void>;
}

/**
 * The classes the lab gives a button node: the renderer's `createItemClass` in
 * `@jupyterlab/apputils`. The mock records the fields of a button, so a test makes
 * the classes the same way the lab does.
 */
function buttonClass(button: IDialogButton): string {
  return [
    'jp-Dialog-button',
    button.accept ? 'jp-mod-accept' : 'jp-mod-reject',
    ...(button.displayType === 'warn' ? ['jp-mod-warn'] : []),
    ...(button.className ? [button.className] : [])
  ].join(' ');
}

/** Every dialog the panel opened in this test, in order. */
const dialogs: IOpenDialog[] = [];

/**
 * The stand-in of `showDialog`: it puts the body into the document and resolves when a
 * test closes the dialog. As the lab does, it reads the value of the body only for a
 * button that accepts.
 */
function recordDialogs(): void {
  dialogs.length = 0;
  (showDialog as jest.Mock).mockReset();
  (showDialog as jest.Mock).mockImplementation(
    (options: Omit<IOpenDialog, 'close'>) =>
      new Promise(resolve => {
        Widget.attach(options.body, document.body);
        dialogs.push({
          ...options,
          async close(label: string): Promise<void> {
            const button = options.buttons.find(
              shown => shown.label === label
            )!;
            const value =
              button.accept && options.body.getValue
                ? options.body.getValue()
                : null;
            Widget.detach(options.body);
            resolve({ button, value, isChecked: null });
            await tick();
          }
        });
      })
  );
}

function setInterface(name: 'serial' | 'usb', value?: object): void {
  delete (navigator as unknown as Record<string, unknown>)[name];
  if (value) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

/** A lab page with the panel in the document, before the worker sent the page a message. */
function newLab(options: ILabOptions = {}): ILab {
  const interfaces = options.interfaces || ['serial', 'usb'];
  const server = new SimServer();
  const serial = new SimSerial(...(options.ports || []));
  const usb = new SimUsb(...(options.devices || []));
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
  if (options.prepare) {
    options.prepare(server);
  }
  const changes: ISerialSettingsChange[] = [];
  const savedConfigs: Array<{ name: string } & ISerialConfig> = [];
  const deleted: string[] = [];
  const stops: string[] = [];
  // The lab always calls fetch with a Request object.
  const fetch = jest.fn(async (request: RequestInfo) => {
    const req = request as Request;
    const { method } = req;
    const path = new URL(req.url).pathname;
    if (path.endsWith('/settings-configs')) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ configs: server.configs }), {
          status: 200
        });
      }
      if (method === 'POST') {
        const body = JSON.parse(await req.text()) as {
          name: string;
        } & ISerialConfig;
        savedConfigs.push(body);
        const saved: ISettingsConfig = {
          id: `config-${savedConfigs.length}`,
          name: body.name,
          system: false,
          baudRate: body.baudRate,
          dataBits: body.dataBits,
          parity: body.parity,
          stopBits: body.stopBits,
          onOpen: body.onOpen
        };
        server.configs.push(saved);
        return new Response(JSON.stringify(saved), { status: 200 });
      }
    }
    if (path.includes('/settings-configs/')) {
      deleted.push(path);
      const id = path.split('/').pop()!;
      const index = server.configs.findIndex(item => item.id === id);
      if (index >= 0) {
        server.configs.splice(index, 1);
      }
      return new Response('{}', { status: 200 });
    }
    // The stop of a run is the one call of the panel without a body.
    if (method === 'DELETE') {
      stops.push(`${method} ${path}`);
      return all.stopAnswer();
    }
    const change = JSON.parse(
      await (request as Request).text()
    ) as ISerialSettingsChange;
    changes.push(change);
    return all.answer(change);
  });
  const model = new DeviceBridgeModel(
    ServerConnection.makeSettings({
      baseUrl: 'http://lab.test/',
      wsUrl: 'ws://lab.test/',
      fetch
    })
  );
  const handlers = {
    connectSerial: jest.fn(),
    connectUsb: jest.fn(),
    grantRequest: jest.fn(),
    openTerminal: jest.fn(),
    startRun: jest.fn(),
    showRunInfo: jest.fn(),
    showHelp: jest.fn()
  };
  // A plus menu with the two connect commands of a registry. Here each command calls
  // a recorder. The plugin leaves out the entry of an interface the browser lacks.
  const commands = new CommandRegistry();
  commands.addCommand(CONNECT_SERIAL, { execute: handlers.connectSerial });
  commands.addCommand(CONNECT_USB, { execute: handlers.connectUsb });
  const addMenu = new MenuSvg({ commands });
  addMenu.addItem({ command: CONNECT_SERIAL });
  addMenu.addItem({ command: CONNECT_USB });
  const panel = new DeviceBridgePanel({
    model,
    addMenu,
    grantRequest: handlers.grantRequest,
    openTerminal: handlers.openTerminal,
    startRun: handlers.startRun,
    showRunInfo: handlers.showRunInfo,
    showHelp: handlers.showHelp
  });
  Widget.attach(panel, document.body);
  const all: ILab = {
    server,
    serial,
    usb,
    changes,
    answer: () => new Response('{}', { status: 200 }),
    savedConfigs,
    deleted,
    stops,
    stopAnswer: () => new Response(null, { status: 204 }),
    fetch,
    model,
    panel,
    addMenu,
    handlers
  };
  return all;
}

/** A lab page with the panel in the document, after the server answered. */
async function lab(options: ILabOptions = {}): Promise<ILab> {
  const all = newLab(options);
  await tick();
  return all;
}

/** The one element of `root` that matches, or an error that names the selector. */
function one<T extends HTMLElement = HTMLElement>(
  root: ParentNode,
  selector: string
): T {
  const found = root.querySelectorAll<T>(selector);
  if (found.length !== 1) {
    throw new Error(`${found.length} elements match ${selector}`);
  }
  return found[0];
}

const row = (all: ILab, name: string): HTMLElement =>
  one(all.panel.node, `[data-device="${name}"]`);

/** The element of a field, with its text and whether the panel shows it. */
const field = (root: ParentNode, name: string): HTMLElement =>
  one(root, `[data-field="${name}"]`);

const text = (root: ParentNode, name: string): string | null =>
  field(root, name).textContent;

const action = (root: ParentNode, name: string): HTMLButtonElement =>
  one<HTMLButtonElement>(root, `[data-action="${name}"]`);

const control = (
  root: ParentNode,
  name: keyof ISerialSettingsChange | 'config'
): HTMLInputElement | HTMLSelectElement =>
  one<HTMLInputElement>(root, `[data-setting-field="${name}"]`);

/** The plus icon of the panel header. */
const plus = (all: ILab): HTMLButtonElement =>
  action(all.panel.node, 'add-device');

/** Whether the plus menu is open: the page then holds its one menu. */
const menuOpen = (): boolean =>
  document.body.querySelectorAll('.lm-Menu').length === 1;

/**
 * Choose an entry of the open plus menu as a click does: the pointer goes up over the
 * entry. Lumino finds the entry under the pointer by its rectangle, and jsdom gives
 * every element an empty rectangle, so the entry gets one first. jsdom has no
 * PointerEvent; Lumino reads the type, the button and the place of the event.
 */
function pick(command: string): void {
  const entry = one(
    document.body,
    `li.lm-Menu-item[data-command="${command}"]`
  );
  const rectangle = jest
    .spyOn(entry, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, right: 100, top: 0, bottom: 20 } as DOMRect);
  entry.dispatchEvent(
    new MouseEvent('pointerup', { bubbles: true, clientX: 1, clientY: 1 })
  );
  rectangle.mockRestore();
}

/** Press the Escape key in the open plus menu. Lumino reads the key code. */
function pressEscape(all: ILab): void {
  all.addMenu.node.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, keyCode: 27 })
  );
}

/** Set a field of the Settings dialog as the user does: the value, then the input and change events. */
function choose(
  root: ParentNode,
  name: keyof ISerialSettingsChange | 'config',
  value: string
) {
  const node = control(root, name);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The baud rate group of the open Settings dialog: the input and its list button. */
const baudGroup = (root: ParentNode): HTMLElement =>
  one(root, '[data-setting-baud]');

/** The button of that group that opens the list of the standard rates. */
const baudToggle = (root: ParentNode): HTMLButtonElement =>
  one<HTMLButtonElement>(root, '.jp-DeviceBridgeSettings-baudToggle');

/** Click Settings in the row of a serial port and return the dialog it opened. */
async function openSettings(all: ILab, name: string): Promise<IOpenDialog> {
  const opened = dialogs.length;
  action(row(all, name), 'settings').click();
  await tick();
  expect(dialogs).toHaveLength(opened + 1);
  return dialogs[opened];
}

/**
 * Make the simulated server act on `PUT serial/<name>/settings` as the real one does:
 * a config replaces the five values, a field changes one and makes the port custom,
 * and the table is sent.
 */
function serveSettings(all: ILab): void {
  all.answer = change => {
    const record = all.server.table.serial[0];
    const { config, ...fields } = change;
    if (config) {
      const chosen = all.server.configs.find(item => item.id === config)!;
      record.configured = {
        baudRate: chosen.baudRate,
        dataBits: chosen.dataBits,
        parity: chosen.parity,
        stopBits: chosen.stopBits,
        onOpen: chosen.onOpen
      };
      record.config = chosen.id;
      record.configName = chosen.name;
    }
    if (Object.keys(fields).length > 0) {
      record.configured = { ...record.configured, ...fields };
      record.config = null;
      record.configName = null;
    }
    const { baudRate, dataBits, parity, stopBits } = record.configured;
    record.settings = { baudRate, dataBits, parity, stopBits };
    all.server.push();
    return new Response(JSON.stringify(record), { status: 200 });
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  emit.mockReset();
  recordDialogs();
});

afterEach(() => {
  jest.useRealTimers();
  setInterface('serial');
  setInterface('usb');
  document.body.replaceChildren();
});

describe('the stylesheet', () => {
  // Node's own modules; the project has no type package for them.
  const fs = jest.requireActual('fs') as {
    readFileSync(file: string, encoding: 'utf8'): string;
  };
  const path = jest.requireActual('path') as {
    resolve(...parts: string[]): string;
  };
  const css = fs
    .readFileSync(
      path.resolve(expect.getState().testPath!, '../../../style/base.css'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /** Every declaration of the stylesheet: the property and its value. */
  const declarations: Array<[property: string, value: string]> = [];
  const declaration = /([\w-]+)\s*:\s*([^;{}]+);/g;
  for (
    let found = declaration.exec(css);
    found;
    found = declaration.exec(css)
  ) {
    declarations.push([found[1], found[2].trim()]);
  }

  it('ACC-PANEL-73 the stylesheet has no hex, rgb or hsl colour and no colour name', () => {
    const literal =
      /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
    const named =
      /\b(white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|cyan|magenta|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;

    expect(declarations.length).toBeGreaterThan(100);
    for (const [, value] of declarations) {
      expect(value).not.toMatch(literal);
      // The name of a variable can hold a colour name, as --md-blue-600 does.
      expect(value.replace(/var\(--[\w-]+/g, 'var(')).not.toMatch(named);
    }
  });

  it('ACC-PANEL-73 every colour of the stylesheet is a JupyterLab variable', () => {
    const colours = declarations.filter(([property]) =>
      /^(color|background|background-color|border|border-top|border-bottom|border-color|outline)$/.test(
        property
      )
    );

    expect(colours.length).toBeGreaterThan(40);
    for (const [, value] of colours) {
      // --jp- are the variables of the themes, --md- the material colours of the lab,
      // --db- this extension's aliases of the theme variables in the Settings token layer.
      expect(value).toMatch(/var\(--(jp|md|db)-|^none$|^transparent$/);
    }
    // An alias resolves to a theme variable or to a colour-mix over one, never to a literal.
    // The radius tokens are lengths, not colours, and stay out of this check.
    const aliases = declarations.filter(
      ([property]) =>
        property.startsWith('--db-') && !property.startsWith('--db-radius')
    );
    expect(aliases.length).toBeGreaterThanOrEqual(8);
    for (const [, value] of aliases) {
      expect(value).toMatch(/^var\(--jp-|^color-mix\(/);
    }
    // The settings dialog keeps one scale: a control of 28 px in the UI font size.
    expect(
      rule(
        '.jp-DeviceBridgeSettings .jp-DeviceBridgePanel-input, .jp-DeviceBridgeSettings .jp-DeviceBridgePanel-input.jp-mod-styled'
      )
    ).toMatchObject({
      height: '28px',
      'font-size': 'var(--jp-ui-font-size1)'
    });
    expect(css).toContain('.jp-DeviceBridgePanel ');
    expect(css).toContain('.jp-DeviceBridgeStatus ');
  });

  /** The declarations of the one rule with exactly this selector. */
  const rule = (selector: string): Record<string, string> => {
    const found = css.split('}').filter(
      // What stands before the brace is the selector of the rule. A long selector
      // is wrapped over several lines by the formatter, so its whitespace collapses.
      text => text.split('{')[0].trim().replace(/\s+/g, ' ') === selector
    );
    expect(found).toHaveLength(1);
    const values: Record<string, string> = {};
    for (const part of found[0].split('{')[1].split(';')) {
      const [property, ...value] = part.split(':');
      if (value.length > 0) {
        // The formatter wraps a long value over several lines.
        values[property.trim()] = value.join(':').replace(/\s+/g, ' ').trim();
      }
    }
    return values;
  };
  const UNLIT_LAMP = '.jp-DeviceBridgePanel-lamp::before';
  const LIT_TX = ".jp-DeviceBridgePanel-lamp[data-lamp='tx'][data-lit]::before";
  const LIT_RX = ".jp-DeviceBridgePanel-lamp[data-lamp='rx'][data-lit]::before";

  it('ACC-PANEL-138 the stylesheet draws a lamp that is not lit as a circle with a border and a background, and a lit lamp with another background, each a JupyterLab variable', () => {
    const unlit = rule(UNLIT_LAMP);

    expect(unlit['border-radius']).toBe('50%');
    expect(unlit.width).toBe(unlit.height);
    expect(unlit.border).toMatch(/^1px solid var\(--jp-[\w-]+\)$/);
    expect(unlit.background).toMatch(/^var\(--jp-[\w-]+\)$/);
    for (const selector of [LIT_TX, LIT_RX]) {
      const lit = rule(selector);
      expect(lit.background).toMatch(/^var\(--(jp|md)-[\w-]+\)$/);
      expect(lit.background).not.toBe(unlit.background);
    }
  });

  it('ACC-PANEL-163 a lit TX lamp is --jp-error-color1 and a lit RX lamp --jp-success-color1, fill and border; a lamp that is off keeps its outlined circle; no rule lights both lamps', () => {
    expect(rule(LIT_TX)).toEqual({
      'border-color': 'var(--jp-error-color1)',
      background: 'var(--jp-error-color1)'
    });
    expect(rule(LIT_RX)).toEqual({
      'border-color': 'var(--jp-success-color1)',
      background: 'var(--jp-success-color1)'
    });
    expect(rule(UNLIT_LAMP)).toMatchObject({
      border: '1px solid var(--jp-border-color1)',
      background: 'var(--jp-layout-color3)'
    });
    expect(css).not.toContain('.jp-DeviceBridgePanel-lamp[data-lit]');
  });

  it('ACC-PANEL-201 ACC-PANEL-202 the kind chip has a pale blue or pink tint and a stronger hue of the same kind for border and text, in both themes', () => {
    expect(rule('.jp-DeviceBridgePanel-kind')).toMatchObject({
      color: 'var(--jp-ui-font-color1)'
    });
    expect(rule('.jp-DeviceBridgePanel-kind::before')).toMatchObject({
      position: 'absolute',
      inset: '0',
      opacity: '0.12'
    });
    expect(
      rule("[data-kind='serial'] .jp-DeviceBridgePanel-kind::before")
    ).toEqual({ background: 'var(--md-blue-600)' });
    expect(
      rule("[data-kind='usb'] .jp-DeviceBridgePanel-kind::before")
    ).toEqual({ background: 'var(--md-pink-400)' });
    expect(rule("[data-kind='serial'] .jp-DeviceBridgePanel-kind")).toEqual({
      'border-color': 'var(--md-blue-800)',
      color: 'var(--md-blue-800)'
    });
    expect(rule("[data-kind='usb'] .jp-DeviceBridgePanel-kind")).toEqual({
      'border-color': 'var(--md-pink-800)',
      color: 'var(--md-pink-800)'
    });
    expect(
      rule(
        "body[data-jp-theme-light='false'] [data-kind='serial'] .jp-DeviceBridgePanel-kind"
      )
    ).toEqual({
      'border-color': 'var(--md-blue-300)',
      color: 'var(--md-blue-300)'
    });
    expect(
      rule(
        "body[data-jp-theme-light='false'] [data-kind='usb'] .jp-DeviceBridgePanel-kind"
      )
    ).toEqual({
      'border-color': 'var(--md-pink-200)',
      color: 'var(--md-pink-200)'
    });
  });

  it('DEF-PANEL-21 the label of an armed button (Confirm stop, Confirm forget) is --jp-ui-inverse-font-color0, which is opaque in both themes, on the red fill, with no opacity and no font weight of its own', () => {
    const armed = rule(
      '.jp-DeviceBridgePanel-button.jp-mod-warn.jp-mod-confirm'
    );

    expect(armed).toEqual({
      background: 'var(--jp-error-color1)',
      color: 'var(--jp-ui-inverse-font-color0)'
    });
  });

  it('ACC-PANEL-219 the footer rule sets no background and no separator line, and keeps its padding, small font and muted text', () => {
    const footer = rule('.jp-DeviceBridgePanel-footer');

    expect(
      Object.keys(footer).filter(key => /^(border|background)/.test(key))
    ).toEqual([]);
    expect(footer).toMatchObject({
      padding: '4px 8px',
      color: 'var(--jp-ui-font-color2)',
      'font-size': 'var(--jp-ui-font-size0)'
    });
  });

  it('ACC-PANEL-219 the round trip value carries the muted colour of the footer', () => {
    const footer = rule('.jp-DeviceBridgePanel-footer');
    const value = rule(
      ".jp-DeviceBridgePanel-footer [data-field='round-trip']"
    );

    expect(footer.color).toBe('var(--jp-ui-font-color2)');
    expect(value.color).toBe(footer.color);
  });

  it('ACC-PANEL-233 the four Settings buttons carry the slim class, and the stylesheet makes them 28px high with 12px padding and 12.5px text, 8px apart', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    const dialog = await openSettings(all, UNO_NAME);

    expect(dialog.buttons.map(shown => shown.className)).toEqual([
      'jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-danger',
      'jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-secondary',
      'jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-secondary',
      'jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-primary'
    ]);
    expect(
      rule('button.jp-Dialog-button.jp-DeviceBridgeSettings-button')
    ).toEqual({
      height: '28px',
      'min-height': '28px',
      padding: '0 12px',
      'border-radius': 'var(--jp-border-radius)',
      'line-height': '26px',
      'font-size': '12.5px'
    });
    expect(
      rule('.jp-Dialog-footer:has(.jp-DeviceBridgeSettings-button)')
    ).toMatchObject({ gap: '8px' });
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-236 Save is the one filled primary button; Cancel and Save as... are secondary and Delete config is an unfilled danger at the far left', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    const dialog = await openSettings(all, UNO_NAME);
    expect(dialog.buttons.map(shown => shown.label)).toEqual([
      'Delete config',
      'Cancel',
      'Save as...',
      'Save'
    ]);
    expect(
      rule('button.jp-Dialog-button.jp-DeviceBridgeSettings-primary')
    ).toEqual({
      padding: '0 18px',
      border: '1px solid var(--jp-brand-color1)',
      background: 'var(--jp-brand-color1)',
      color: 'var(--jp-ui-inverse-font-color0)',
      'font-weight': '600'
    });
    expect(
      rule('button.jp-Dialog-button.jp-DeviceBridgeSettings-secondary')
    ).toEqual({
      border: '1px solid var(--jp-border-color2)',
      background: 'var(--db-secondary)',
      color: 'var(--jp-ui-font-color0)'
    });
    expect(
      rule(
        '.jp-Dialog-footer:has(.jp-DeviceBridgeSettings-button) button.jp-Dialog-button.jp-DeviceBridgeSettings-danger'
      )
    ).toEqual({
      'margin-right': 'auto',
      border: '1px solid var(--db-danger-border)',
      background: 'transparent',
      color: 'var(--jp-error-color1)'
    });
    // The buttons draw no ring unless the keyboard focuses them.
    expect(
      rule('button.jp-Dialog-button.jp-DeviceBridgeSettings-button:focus')
    ).toEqual({ outline: 'none' });
    expect(
      rule(
        'button.jp-Dialog-button.jp-DeviceBridgeSettings-button:focus-visible'
      )
    ).toEqual({
      outline: '2px solid var(--jp-brand-color2)',
      'outline-offset': '1px'
    });
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-232 the stylesheet caps the Serial settings dialog at 680 px, fixes the table at 42/58 columns with 40 px rows, and gives every control 28 px and the full value column', () => {
    expect(
      rule('.jp-Dialog-content:has(.jp-DeviceBridgeSettings-table)')
    ).toEqual({
      width: 'min(680px, calc(100vw - 32px))',
      'max-width': 'min(680px, calc(100vw - 32px))',
      'min-width': 'min(520px, calc(100vw - 32px))'
    });
    expect(rule('.jp-DeviceBridgeSettings-table')).toEqual({
      width: '100%',
      'table-layout': 'fixed',
      'border-collapse': 'collapse'
    });
    expect(
      rule(
        '.jp-DeviceBridgeSettings-table th, .jp-DeviceBridgeSettings-table td'
      )
    ).toMatchObject({
      'box-sizing': 'border-box',
      height: '40px',
      padding: '6px 12px'
    });
    expect(rule('.jp-DeviceBridgeSettings-table th')).toMatchObject({
      width: '42%',
      color: 'var(--jp-ui-font-color2)',
      'font-size': 'var(--jp-ui-font-size1)',
      'font-weight': '400'
    });
    expect(rule('.jp-DeviceBridgeSettings-table td')).toMatchObject({
      width: '58%',
      color: 'var(--jp-ui-font-color0)',
      'font-size': 'var(--jp-ui-font-size1)'
    });
    expect(rule('.jp-DeviceBridgeSettings-field')).toMatchObject({
      display: 'flex',
      'align-items': 'center',
      'min-width': '0'
    });
    expect(
      rule(
        '.jp-DeviceBridgeSettings .jp-DeviceBridgePanel-input, .jp-DeviceBridgeSettings .jp-DeviceBridgePanel-input.jp-mod-styled'
      )
    ).toMatchObject({
      'box-sizing': 'border-box',
      flex: '1 1 auto',
      width: '100%',
      height: '28px',
      'min-height': '28px',
      'font-size': 'var(--jp-ui-font-size1)'
    });
    expect(
      rule(
        '.jp-DeviceBridgeSettings .jp-DeviceBridgeSettings-field .jp-select-wrapper'
      )
    ).toMatchObject({
      flex: '1 1 auto',
      width: '100%',
      'min-width': '0',
      height: '28px',
      margin: '0',
      padding: '0'
    });
    // The baud rate is an input joined to a 30 px button in one group.
    expect(rule('.jp-DeviceBridgeSettings-baud')).toMatchObject({
      display: 'flex',
      'min-width': '0',
      'border-radius': 'var(--jp-border-radius)'
    });
    expect(
      rule(
        '.jp-DeviceBridgeSettings-baudToggle, .jp-DeviceBridgeSettings-baudToggle.jp-mod-styled'
      )
    ).toMatchObject({
      'box-sizing': 'border-box',
      flex: '0 0 30px',
      'min-width': '30px',
      height: '28px',
      'line-height': '1',
      padding: '0'
    });
  });

  it('ACC-PANEL-237 the rows carry a 9% hairline and no band fill; labels are muted and values primary at the UI size', () => {
    expect(css).not.toContain(':nth-child(odd)');
    expect(css).not.toContain(':nth-child(even)');
    expect(css).not.toContain('--db-row-odd');
    expect(css).not.toContain('--db-row-even');
    expect(
      rule(
        '.jp-DeviceBridgeSettings-table tbody tr + tr th, .jp-DeviceBridgeSettings-table tbody tr + tr td'
      )
    ).toEqual({ 'box-shadow': 'inset 0 1px 0 var(--db-line)' });
    // The formatter wraps the mix over several lines; it is one expression.
    const normal = (value: string): string =>
      value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    const tokens = rule('.jp-Dialog-content:has(.jp-DeviceBridgeSettings)');
    expect(normal(tokens['--db-line'])).toBe(
      'color-mix(in srgb, var(--jp-ui-font-color0) 9%, transparent)'
    );
    expect(rule('.jp-DeviceBridgeSettings-table th')).toMatchObject({
      color: 'var(--jp-ui-font-color2)'
    });
    expect(rule('.jp-DeviceBridgeSettings-table td')).toMatchObject({
      color: 'var(--jp-ui-font-color0)',
      'font-size': 'var(--jp-ui-font-size1)'
    });
  });
});

describe('DeviceBridgePanel: the device rows', () => {
  it('ACC-PANEL-64 a serial row shows kind, name, state, holding program, baud rate, config and action on open; a USB row shows kind, name, state and product', async () => {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      devices: [new SimUsbDevice()]
    });
    const serialRow = row(all, UNO_NAME);
    const usbRow = row(all, PROBE_NAME);

    expect(all.panel.id).toBe('jupyterlab-device-bridge-panel');
    expect(serialRow.dataset).toMatchObject({
      kind: 'serial',
      state: 'attached',
      owner: 'this'
    });
    expect(text(serialRow, 'kind')).toBe('Serial');
    expect(text(serialRow, 'name')).toBe(UNO_NAME);
    expect(text(serialRow, 'state')).toBe('attached');
    expect(text(serialRow, 'baud')).toBe('115200');
    expect(text(serialRow, 'config')).toBe('custom');
    expect(text(serialRow, 'on-open')).toBe('Do nothing');
    expect(text(serialRow, 'holder')).toBe('none');

    expect(usbRow.dataset).toMatchObject({
      kind: 'usb',
      state: 'attached',
      owner: 'this'
    });
    expect(text(usbRow, 'kind')).toBe('USB');
    expect(text(usbRow, 'name')).toBe(PROBE_NAME);
    expect(text(usbRow, 'state')).toBe('attached');
    expect(text(usbRow, 'product')).toBe('Simulation Simulated Probe');
    expect(text(usbRow, 'opened')).toBe('no');
    expect(usbRow.querySelector('[data-field="baud"]')).toBeNull();
    expect(usbRow.querySelector('[data-action="terminal"]')).toBeNull();
    expect(usbRow.querySelector('[data-setting-field]')).toBeNull();
    expect(usbRow.querySelector('[data-action="settings"]')).toBeNull();

    // A tool opens the virtual device at 57600 baud, and a program opens the probe.
    Object.assign(all.server.table.serial[0], {
      holder: { pid: 4242, name: 'avrdude' },
      settings: { ...all.server.settings, baudRate: 57600 }
    });
    all.server.table.usb[0].opened = true;
    all.server.push();
    await tick();

    expect(text(serialRow, 'holder')).toBe('avrdude (pid 4242)');
    expect(text(serialRow, 'baud')).toBe('57600');
    expect(text(usbRow, 'opened')).toBe('yes');
    expect(text(all.panel.node, 'round-trip')).toMatch(/^\d+\.\d ms$/);
  });

  it('ACC-PANEL-112 a USB row names the program that has the device open, and no program once the device is closed', async () => {
    const all = await lab({ devices: [new SimUsbDevice()] });
    const usbRow = row(all, PROBE_NAME);

    expect(text(usbRow, 'opened')).toBe('no');
    expect(text(usbRow, 'holder')).toBe('none');

    Object.assign(all.server.table.usb[0], {
      opened: true,
      holder: { name: 'pyocd' }
    });
    all.server.push();
    await tick();

    expect(text(usbRow, 'opened')).toBe('yes');
    expect(text(usbRow, 'holder')).toBe('pyocd');

    // A program that named nobody opened the device.
    all.server.table.usb[0].holder = null;
    all.server.push();
    await tick();

    expect(text(usbRow, 'opened')).toBe('yes');
    expect(text(usbRow, 'holder')).toBe('none');

    all.server.table.usb[0].holder = { name: 'dfu-util' };
    all.server.push();
    await tick();
    expect(text(usbRow, 'holder')).toBe('dfu-util');

    Object.assign(all.server.table.usb[0], { opened: false, holder: null });
    all.server.push();
    await tick();

    expect(text(usbRow, 'opened')).toBe('no');
    expect(text(usbRow, 'holder')).toBe('none');
  });

  it('ACC-PANEL-64 the list has one row per device of the table, a count, and a text while it is empty', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab();
    const rows = (): string[] =>
      Array.from(
        all.panel.node.querySelectorAll<HTMLElement>('[data-device]'),
        node => node.dataset.device!
      );
    const section = one(all.panel.node, '[data-section="devices"]');
    const empty = one(section, '.jp-DeviceBridgePanel-empty');
    const count = (): string | null => text(section, 'count');

    expect(rows()).toEqual([]);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe('No device attached');
    expect(count()).toBe('(0)');

    all.serial.dialog = port;
    await all.model.connectSerial();
    all.usb.dialog = new SimUsbDevice();
    await all.model.connectUsb();
    await tick();

    expect(rows()).toEqual([UNO_NAME, PROBE_NAME]);
    expect(empty.hidden).toBe(true);
    expect(count()).toBe('(2)');
  });

  it('ACC-PANEL-64 a USB device without names has no product line', async () => {
    const all = await lab({
      devices: [new SimUsbDevice({ productName: null, manufacturerName: null })]
    });
    const product = field(row(all, PROBE_NAME), 'product');

    expect(product.textContent).toBe('');
    expect(product.parentElement!.hidden).toBe(true);
  });

  it('ACC-PANEL-65 the byte counters of a row grow with the bytes the port sends and receives', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const serialRow = row(all, UNO_NAME);

    expect(text(serialRow, 'rx')).toBe('0 bytes');
    expect(text(serialRow, 'tx')).toBe('0 bytes');

    port.receive([1, 2, 3]);
    await tick(1000);
    expect(text(serialRow, 'rx')).toBe('3 bytes');
    expect(text(serialRow, 'tx')).toBe('0 bytes');

    // The port echoes: two bytes written to it come back.
    all.server.sendData(1, [9, 9]);
    await tick(1000);
    expect(text(serialRow, 'rx')).toBe('5 bytes');
    expect(text(serialRow, 'tx')).toBe('2 bytes');
  });

  it('ACC-SERIAL-17 a port the browser cannot open shows the reason text of the browser in its row', async () => {
    const port = new SimSerialPort(UNO);
    port.openError = new DOMException(
      'Failed to open serial port.',
      'NetworkError'
    );
    const all = await lab({ ports: [port] });
    const error = field(row(all, UNO_NAME), 'error');

    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Failed to open serial port.');

    // The user detaches the port and attaches it again; this time it opens.
    port.openError = null;
    action(row(all, UNO_NAME), 'detach').click();
    await tick();
    action(row(all, UNO_NAME), 'attach').click();
    await tick();

    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe('');
  });

  it('ACC-SERIAL-16 a port that was unplugged reads removed as its state and shows no error text', async () => {
    const all = await lab({
      prepare: server => {
        server.table.serial.push({
          ...HELD,
          state: 'detached',
          tab: null,
          error: 'removed'
        });
      }
    });
    const serialRow = row(all, UNO_NAME);

    expect(serialRow.dataset.state).toBe('detached');
    expect(text(serialRow, 'state')).toBe('removed');
    expect(field(serialRow, 'error').hidden).toBe(true);
    expect(text(serialRow, 'error')).toBe('');
  });

  it('ACC-PANEL-164 an update of the device table keeps the row element and leaves the fields of an open Settings dialog as the user set them', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const serialRow = row(all, UNO_NAME);
    const settings = await openSettings(all, UNO_NAME);
    choose(settings.body.node, 'baudRate', '96');
    const baud = control(settings.body.node, 'baudRate');

    port.receive([1]);
    await tick(1000);

    expect(text(serialRow, 'rx')).toBe('1 byte');
    expect(row(all, UNO_NAME)).toBe(serialRow);
    expect(baud.value).toBe('96');
    await settings.close('Cancel');
  });
});

describe('DeviceBridgePanel: the activity lamps of a device row', () => {
  /** How long one event keeps a lamp lit, as docs/design.md says. */
  const LIT_MS = 200;
  /** How often the worker looks at its byte counters, as docs/design.md says. */
  const LOOK_MS = 50;
  /** A serial port that another tab holds, with counters above zero in its first table. */
  const BUSY: ISerialRecord = { ...HELD, rx: 500, tx: 300 };

  const lamp = (root: ParentNode, name: 'tx' | 'rx'): HTMLElement =>
    one(root, `[data-lamp="${name}"]`);

  /** Whether the lamps TX and RX of a row are lit, in this order. */
  const lit = (root: ParentNode): boolean[] => [
    lamp(root, 'tx').hasAttribute('data-lit'),
    lamp(root, 'rx').hasAttribute('data-lit')
  ];

  /** A lab whose server lists the port `BUSY` in the first table it sends. */
  const busyLab = (): Promise<ILab> =>
    lab({
      prepare: server => {
        server.table.serial.push({ ...BUSY });
      }
    });

  /**
   * A lab with one port that this tab holds. The port does not echo, so the two
   * directions move bytes apart. The worker looks at its counters 50 ms after the
   * port opened, and then every 50 ms.
   */
  async function ownLab(): Promise<ILab & { port: SimSerialPort }> {
    const port = new SimSerialPort(UNO);
    port.echo = false;
    return { ...(await lab({ ports: [port] })), port };
  }

  /** Set counters of the first serial record and send the device table. */
  async function count(
    all: ILab,
    counters: { rx?: number; tx?: number }
  ): Promise<void> {
    Object.assign(all.server.table.serial[0], counters);
    all.server.push();
    await tick();
  }

  /** One USB operation on the probe, as the server sends it for a program. */
  function probe(all: ILab, op: 'open' | 'out' | 'in'): void {
    if (op === 'open') {
      all.server.command({ type: 'usb', name: PROBE_NAME, op });
    } else if (op === 'out') {
      all.server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'transfer-out',
        args: { endpointNumber: BULK_ENDPOINT, data: toBase64([1, 2, 3]) }
      });
    } else {
      all.server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'transfer-in',
        args: { endpointNumber: BULK_ENDPOINT, length: 64 }
      });
    }
  }

  it('ACC-PANEL-138 a serial row and a USB row each have the lamps TX and RX with their labels and titles, and the first table of a row lights nothing', async () => {
    const all = await lab({
      devices: [new SimUsbDevice()],
      prepare: server => {
        server.table.serial.push({ ...BUSY });
      }
    });

    for (const name of [UNO_NAME, PROBE_NAME]) {
      const deviceRow = row(all, name);
      const lamps = deviceRow.querySelectorAll<HTMLElement>('[data-lamp]');

      expect(Array.from(lamps, node => node.dataset.lamp)).toEqual([
        'tx',
        'rx'
      ]);
      expect(lamp(deviceRow, 'tx').textContent).toBe('TX');
      expect(lamp(deviceRow, 'tx').title).toBe('bytes to the device');
      expect(lamp(deviceRow, 'rx').textContent).toBe('RX');
      expect(lamp(deviceRow, 'rx').title).toBe('bytes from the device');
      expect(lit(deviceRow)).toEqual([false, false]);
    }
    // The first table of the serial row carried counters above zero.
    expect(text(row(all, UNO_NAME), 'rx')).toBe('500 bytes');
    expect(text(row(all, UNO_NAME), 'tx')).toBe('300 bytes');
  });

  it('ACC-PANEL-138 bytes of a port this tab holds light the lamp of their direction at the next look of the worker, for 200 ms', async () => {
    const all = await ownLab();
    const serialRow = row(all, UNO_NAME);

    all.port.receive([1, 2, 3]);
    await tick(LOOK_MS - 1);
    expect(lit(serialRow)).toEqual([false, false]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, true]);

    await tick(LIT_MS - 1);
    expect(lit(serialRow)).toEqual([false, true]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, false]);

    // Bytes that a tool writes: the server sends them, and the worker writes them.
    all.server.sendData(1, [9, 9]);
    await tick(LOOK_MS);
    expect(all.port.written).toEqual([9, 9]);
    expect(lit(serialRow)).toEqual([true, false]);
    await tick(LIT_MS);
    expect(lit(serialRow)).toEqual([false, false]);

    // Bytes in both directions in one period light both lamps.
    all.port.receive([4]);
    all.server.sendData(1, [8]);
    await tick(LOOK_MS);
    expect(lit(serialRow)).toEqual([true, true]);
    await tick(LIT_MS);
    expect(lit(serialRow)).toEqual([false, false]);
  });

  it('ACC-PANEL-138 the lamps of a USB row this tab holds follow the transfers of the device', async () => {
    const all = await lab({ devices: [new SimUsbDevice()] });
    const usbRow = row(all, PROBE_NAME);

    // The descriptors that the worker reads at the open are no traffic of a program.
    probe(all, 'open');
    await tick(LOOK_MS);
    expect(lit(usbRow)).toEqual([false, false]);

    probe(all, 'out');
    await tick(LOOK_MS);
    expect(lit(usbRow)).toEqual([true, false]);
    await tick(LIT_MS);
    expect(lit(usbRow)).toEqual([false, false]);

    probe(all, 'in');
    await tick(LOOK_MS);
    expect(lit(usbRow)).toEqual([false, true]);
  });

  it('ACC-PANEL-138 an activity message lights the lamps of the row of the device it names, and of no other row', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port], devices: [new SimUsbDevice()] });
    probe(all, 'open');
    await tick(LOOK_MS);

    port.receive([1]);
    await tick(LOOK_MS);
    expect(lit(row(all, UNO_NAME))).toEqual([false, true]);
    expect(lit(row(all, PROBE_NAME))).toEqual([false, false]);
    await tick(LIT_MS);

    probe(all, 'out');
    await tick(LOOK_MS);
    expect(lit(row(all, UNO_NAME))).toEqual([false, false]);
    expect(lit(row(all, PROBE_NAME))).toEqual([true, false]);
  });

  it('ACC-PANEL-138 bursts 400 ms apart give single flashes: the lamp is lit for 200 ms after each burst and off until the next', async () => {
    const all = await ownLab();
    const serialRow = row(all, UNO_NAME);

    for (let burst = 0; burst < 5; burst++) {
      all.port.receive([burst, burst]);
      await tick(LOOK_MS);
      expect(lit(serialRow)).toEqual([false, true]);
      await tick(LIT_MS - 1);
      expect(lit(serialRow)).toEqual([false, true]);
      await tick(1);
      expect(lit(serialRow)).toEqual([false, false]);
      await tick(400 - LOOK_MS - LIT_MS);
      expect(lit(serialRow)).toEqual([false, false]);
    }
  });

  it('ACC-PANEL-138 bytes in every 50 ms period give a steady light: the lamp stays lit until 200 ms after the last period with bytes', async () => {
    const all = await ownLab();
    const serialRow = row(all, UNO_NAME);

    all.port.receive([0]);
    await tick(LOOK_MS);
    // One second of traffic, read every 25 ms.
    for (let period = 1; period <= 20; period++) {
      expect(lit(serialRow)).toEqual([false, true]);
      all.port.receive([period]);
      await tick(LOOK_MS / 2);
      expect(lit(serialRow)).toEqual([false, true]);
      await tick(LOOK_MS / 2);
    }

    await tick(LIT_MS - 1);
    expect(lit(serialRow)).toEqual([false, true]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, false]);
  });

  it('ACC-PANEL-138 a table update with a larger counter lights nothing for a device this tab holds', async () => {
    const all = await ownLab();
    const serialRow = row(all, UNO_NAME);

    all.port.receive([1, 2, 3]);
    all.server.sendData(1, [9, 9]);
    await tick(LOOK_MS + LIT_MS);
    // The flash for these bytes is over, and the table still has the old counters.
    expect(lit(serialRow)).toEqual([false, false]);
    expect(text(serialRow, 'rx')).toBe('0 bytes');
    expect(text(serialRow, 'tx')).toBe('0 bytes');

    // The worker sends the counters once a second, and the server sends the table.
    await tick(1000 - LOOK_MS - LIT_MS);
    expect(text(serialRow, 'rx')).toBe('3 bytes');
    expect(text(serialRow, 'tx')).toBe('2 bytes');
    expect(lit(serialRow)).toEqual([false, false]);
  });

  it('ACC-PANEL-138 for a device another tab holds a larger rx counter lights the RX lamp for 200 ms and a larger tx counter the TX lamp, and the counter fields keep their counts', async () => {
    const all = await busyLab();
    const serialRow = row(all, UNO_NAME);

    await count(all, { rx: 501 });
    expect(lit(serialRow)).toEqual([false, true]);
    expect(text(serialRow, 'rx')).toBe('501 bytes');
    expect(text(serialRow, 'tx')).toBe('300 bytes');

    await tick(LIT_MS - 1);
    expect(lit(serialRow)).toEqual([false, true]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, false]);

    await count(all, { tx: 364 });
    expect(lit(serialRow)).toEqual([true, false]);
    expect(text(serialRow, 'tx')).toBe('364 bytes');

    await tick(LIT_MS - 1);
    expect(lit(serialRow)).toEqual([true, false]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, false]);

    // One table with both counters larger lights both lamps.
    await count(all, { rx: 502, tx: 365 });
    expect(lit(serialRow)).toEqual([true, true]);
    await tick(LIT_MS);
    expect(lit(serialRow)).toEqual([false, false]);
  });

  it('ACC-PANEL-138 for a device another tab holds an equal counter and a smaller counter light nothing, and the next counter above the one the row showed lights the lamp', async () => {
    const all = await busyLab();
    const serialRow = row(all, UNO_NAME);

    // The same table again, as after a change of another device.
    await count(all, {});
    expect(lit(serialRow)).toEqual([false, false]);

    // Smaller counters: the port was attached again and counts from zero.
    await count(all, { rx: 400, tx: 0 });
    expect(lit(serialRow)).toEqual([false, false]);
    expect(text(serialRow, 'rx')).toBe('400 bytes');
    expect(text(serialRow, 'tx')).toBe('0 bytes');

    await count(all, { rx: 401 });
    expect(lit(serialRow)).toEqual([false, true]);
  });

  it('ACC-PANEL-138 a second event that arrives while the lamp is lit keeps it lit for 200 ms from that event', async () => {
    const all = await busyLab();
    const serialRow = row(all, UNO_NAME);

    await count(all, { rx: 501 });
    await tick(50);
    await count(all, { rx: 502 });

    // 249 ms after the first update and 199 ms after the second.
    await tick(LIT_MS - 1);
    expect(lit(serialRow)).toEqual([false, true]);
    await tick(1);
    expect(lit(serialRow)).toEqual([false, false]);
  });

  it('ACC-PANEL-138 the timer of a lit lamp ends with its row: a row that left the table has no pending timer and is not touched 200 ms later', async () => {
    const all = await busyLab();
    const pending = jest.getTimerCount();
    await count(all, { rx: 501 });
    const rx = lamp(row(all, UNO_NAME), 'rx');

    expect(rx.hasAttribute('data-lit')).toBe(true);
    expect(jest.getTimerCount()).toBe(pending + 1);

    // The other tab forgets the port: the server lists it no more.
    all.server.table.serial.length = 0;
    all.server.push();
    await tick();

    expect(rx.isConnected).toBe(false);
    expect(jest.getTimerCount()).toBe(pending);
    // A timer that still ran would take the attribute from the removed lamp.
    await tick(LIT_MS);
    expect(rx.hasAttribute('data-lit')).toBe(true);
  });

  it('ACC-PANEL-138 a row that left the table takes no activity message any more: later bytes of its device do not light its removed lamp', async () => {
    const all = await ownLab();
    let messages = 0;
    all.model.activity.connect(() => messages++);
    all.port.receive([1]);
    await tick(LOOK_MS);
    const rx = lamp(row(all, UNO_NAME), 'rx');
    expect(rx.hasAttribute('data-lit')).toBe(true);
    expect(messages).toBe(1);

    // The WebSocket closes: the table is empty, and the port stays open in the worker.
    all.server.accepting = false;
    all.server.drop();
    expect(rx.isConnected).toBe(false);
    expect(all.port.isOpen).toBe(true);
    await tick(LIT_MS);
    rx.removeAttribute('data-lit');

    all.port.receive([2]);
    await tick(LOOK_MS);
    expect(messages).toBe(2);
    expect(rx.hasAttribute('data-lit')).toBe(false);
  });

  it('ACC-PANEL-138 the timers of the lit lamps end with the panel: a disposed panel has no pending timer, and its lamps are not touched 200 ms later and not lit by later activity', async () => {
    const all = await lab({
      devices: [new SimUsbDevice()],
      prepare: server => {
        server.table.serial.push({ ...BUSY });
      }
    });
    let messages = 0;
    all.model.activity.connect(() => messages++);
    probe(all, 'open');
    await tick();
    const pending = jest.getTimerCount();
    const serialRow = row(all, UNO_NAME);
    const usbRow = row(all, PROBE_NAME);

    // The probe of this tab is lit by the worker, the port of the other tab by its counters.
    probe(all, 'out');
    await tick(LOOK_MS);
    await count(all, { rx: 501, tx: 301 });
    expect(lit(serialRow)).toEqual([true, true]);
    expect(lit(usbRow)).toEqual([true, false]);
    expect(jest.getTimerCount()).toBe(pending + 3);

    all.panel.dispose();

    expect(serialRow.isConnected).toBe(false);
    expect(jest.getTimerCount()).toBe(pending);
    await tick(LIT_MS);
    expect(lit(serialRow)).toEqual([true, true]);
    expect(lit(usbRow)).toEqual([true, false]);

    lamp(usbRow, 'tx').removeAttribute('data-lit');
    probe(all, 'out');
    await tick(LOOK_MS);
    expect(messages).toBe(2);
    expect(lit(usbRow)).toEqual([false, false]);
  });
});

describe('DeviceBridgePanel: attach, detach, forget', () => {
  it('ACC-SERIAL-18 Detach closes the port and the row reads detached; Attach opens it again without a dialog', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const serialRow = row(all, UNO_NAME);

    expect(action(serialRow, 'detach').hidden).toBe(false);
    expect(action(serialRow, 'forget').hidden).toBe(false);
    expect(action(serialRow, 'terminal').hidden).toBe(false);
    expect(action(serialRow, 'attach').hidden).toBe(true);

    action(serialRow, 'detach').click();
    await tick();

    expect(port.isOpen).toBe(false);
    expect(port.forgotten).toBe(false);
    expect(serialRow.dataset).toMatchObject({
      state: 'detached',
      owner: 'none'
    });
    expect(text(serialRow, 'state')).toBe('detached');
    expect(action(serialRow, 'detach').hidden).toBe(true);
    expect(action(serialRow, 'terminal').hidden).toBe(true);
    expect(action(serialRow, 'attach').hidden).toBe(false);
    expect(action(serialRow, 'forget').hidden).toBe(false);

    action(serialRow, 'attach').click();
    await tick();

    expect(port.isOpen).toBe(true);
    expect(all.serial.dialogs).toEqual([]);
    expect(text(serialRow, 'state')).toBe('attached');
    expect(action(serialRow, 'attach').hidden).toBe(true);
    expect(action(serialRow, 'detach').hidden).toBe(false);
  });

  it('ACC-SERIAL-19 Forget asks for a second click, then revokes the grant and the row goes', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const forget = action(row(all, UNO_NAME), 'forget');

    expect(forget.textContent).toBe('Forget');
    expect(forget.classList.contains('jp-mod-confirm')).toBe(false);

    forget.click();
    await tick();
    expect(forget.textContent).toBe('Confirm forget');
    expect(forget.classList.contains('jp-mod-confirm')).toBe(true);
    expect(port.forgotten).toBe(false);

    // The second click of a double click comes too early and does nothing.
    forget.click();
    await tick(ARM_DELAY_MS - 1);
    expect(port.forgotten).toBe(false);
    expect(forget.textContent).toBe('Confirm forget');

    await tick(1);
    forget.click();
    await tick();
    expect(port.forgotten).toBe(true);
    expect(port.isOpen).toBe(false);
    expect(all.panel.node.querySelector('[data-device]')).toBeNull();
    expect(all.model.devices.serial).toEqual([]);
  });

  it('ACC-SERIAL-19 a port that is granted again after Forget gets a row again', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const forget = action(row(all, UNO_NAME), 'forget');
    forget.click();
    await tick(ARM_DELAY_MS);
    forget.click();
    await tick();
    expect(all.panel.node.querySelector('[data-device]')).toBeNull();

    port.forgotten = false;
    all.serial.dialog = port;
    await all.model.connectSerial();
    await tick();

    expect(text(row(all, UNO_NAME), 'state')).toBe('attached');
    expect(action(row(all, UNO_NAME), 'forget').textContent).toBe('Forget');
  });

  it('ACC-SERIAL-19 an armed Forget goes back to Forget when the focus leaves it', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const forget = action(row(all, UNO_NAME), 'forget');

    forget.focus();
    forget.click();
    expect(forget.textContent).toBe('Confirm forget');
    forget.blur();
    expect(forget.textContent).toBe('Forget');
    expect(forget.classList.contains('jp-mod-confirm')).toBe(false);

    // The next click arms it again and does not act.
    await tick(ARM_DELAY_MS);
    forget.click();
    await tick();
    expect(forget.textContent).toBe('Confirm forget');
    expect(port.forgotten).toBe(false);
  });

  it('ACC-USB-45 a USB row has Detach and Forget, and they act on the device', async () => {
    const device = new SimUsbDevice();
    const all = await lab({ devices: [device] });
    const usbRow = row(all, PROBE_NAME);

    action(usbRow, 'detach').click();
    await tick();
    expect(text(usbRow, 'state')).toBe('detached');
    expect(action(usbRow, 'attach').hidden).toBe(false);

    action(usbRow, 'forget').click();
    await tick(ARM_DELAY_MS);
    action(usbRow, 'forget').click();
    await tick();
    expect(device.forgotten).toBe(true);
    expect(all.panel.node.querySelector('[data-device]')).toBeNull();
  });

  it('ACC-PANEL-71 a device another tab holds reads held by another tab and has no Detach, no Forget and no Attach', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({
      ports: [port],
      prepare: server => {
        server.table.serial.push({ ...HELD });
        server.heldBy.set(UNO_KEY, 'tab-2');
      }
    });
    const serialRow = row(all, UNO_NAME);

    expect(serialRow.dataset).toMatchObject({
      state: 'attached',
      owner: 'other'
    });
    expect(text(serialRow, 'state')).toBe('held by another tab');
    expect(action(serialRow, 'detach').hidden).toBe(true);
    expect(action(serialRow, 'forget').hidden).toBe(true);
    expect(action(serialRow, 'attach').hidden).toBe(true);
    // The virtual device of the port is in the container, whichever tab holds the port.
    expect(action(serialRow, 'terminal').hidden).toBe(false);
    expect(port.calls).toEqual([]);

    // The other tab gives the port up: this tab has a grant for it and offers Attach.
    all.server.heldBy.clear();
    Object.assign(all.server.table.serial[0], { state: 'detached', tab: null });
    all.server.push();
    await tick();

    expect(text(serialRow, 'state')).toBe('detached');
    expect(action(serialRow, 'attach').hidden).toBe(false);
    expect(action(serialRow, 'forget').hidden).toBe(false);
    expect(action(serialRow, 'detach').hidden).toBe(true);
  });

  it('ACC-PANEL-71 a detached device that this tab has no grant for offers Forget and no Attach', async () => {
    const all = await lab({
      prepare: server => {
        server.table.serial.push({ ...HELD, state: 'detached', tab: null });
      }
    });
    const serialRow = row(all, UNO_NAME);

    expect(text(serialRow, 'state')).toBe('detached');
    expect(action(serialRow, 'attach').hidden).toBe(true);
    expect(action(serialRow, 'detach').hidden).toBe(true);
    expect(action(serialRow, 'forget').hidden).toBe(false);
  });
});

describe('DeviceBridgePanel: the Settings dialog of a serial row', () => {
  /** A lab with one attached port and a server that takes settings changes. */
  async function labWithConfigs(): Promise<ILab> {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    serveSettings(all);
    return all;
  }

  /** The values of the six fields of a dialog, in the order of the dialog. */
  const values = (dialog: IOpenDialog): string[] =>
    Array.from(
      dialog.body.node.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '[data-setting-field]'
      ),
      node => `${node.dataset.settingField}=${node.value}`
    );

  it('ACC-PANEL-164 a serial row has the button Settings and no folded editor; Settings opens a dialog of the lab with the six fields filled with the values of the port, and the buttons Cancel, Delete config, Save as... and Save', async () => {
    const all = await labWithConfigs();
    const serialRow = row(all, UNO_NAME);
    const settings = action(serialRow, 'settings');

    expect(settings.textContent).toBe('Settings');
    expect(settings.hidden).toBe(false);
    expect(serialRow.querySelector('details')).toBeNull();
    expect(serialRow.querySelector('[data-setting-field]')).toBeNull();
    expect(serialRow.textContent).not.toContain('Profile settings');
    expect(showDialog).not.toHaveBeenCalled();

    const dialog = await openSettings(all, UNO_NAME);

    expect(dialog.title).toBe(`Serial settings of ${UNO_NAME}`);
    expect(dialog.buttons.map(shown => [shown.label, shown.accept])).toEqual([
      ['Delete config', true],
      ['Cancel', false],
      ['Save as...', false],
      ['Save', true]
    ]);
    expect(values(dialog)).toEqual([
      'config=',
      'baudRate=115200',
      'dataBits=8',
      'parity=none',
      'stopBits=1',
      'onOpen=none'
    ]);
    // Each field has its label.
    expect(
      Array.from(
        dialog.body.node.querySelectorAll('.jp-DeviceBridgePanel-fieldLabel'),
        label => label.textContent
      )
    ).toEqual([
      'Config',
      'Baud rate',
      'Data bits',
      'Parity',
      'Stop bits',
      'When a program opens the port'
    ]);
    await dialog.close('Cancel');
  });

  it('ACC-PROF-207 the dialog offers Custom, each config of the server and the choices of each field', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);
    const options = (name: keyof ISerialSettingsChange | 'config'): string[] =>
      Array.from(
        (control(dialog.body.node, name) as HTMLSelectElement).options,
        option => option.value
      );

    expect(options('config')).toEqual([
      '',
      'monitor',
      'arduino-upload',
      'arduino-isp',
      'stm32-bootloader',
      'esp-upload'
    ]);
    expect(options('dataBits')).toEqual(['7', '8']);
    expect(options('parity')).toEqual(['none', 'even', 'odd']);
    expect(options('stopBits')).toEqual(['1', '2']);
    expect(options('onOpen')).toEqual([
      'none',
      'pulse-dtr',
      'pulse-rts',
      'esp-bootloader',
      'touch-1200'
    ]);
    await dialog.close('Cancel');
  });

  it('ACC-PROF-123 each choice of a default setting in the settings schema has the value and the label that the Settings dialog shows for it', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);
    // The schema file is the one the Settings Editor of the lab reads.
    const { properties } = jest.requireActual('../../schema/plugin.json') as {
      properties: Record<
        string,
        { oneOf: Array<{ const: string | number; title: string }> }
      >;
    };
    /** The value and the title of every choice of a setting. */
    const choices = (setting: string): string[][] =>
      properties[setting].oneOf.map(choice => [
        String(choice.const),
        choice.title
      ]);
    /** The value and the label of every option of a select of the dialog. */
    const offered = (
      name: keyof ISerialSettingsChange | 'config'
    ): string[][] =>
      Array.from(
        (control(dialog.body.node, name) as HTMLSelectElement).options,
        option => [option.value, option.textContent ?? '']
      );

    expect(choices('defaultParity')).toEqual(offered('parity'));
    expect(choices('defaultOnOpen')).toEqual(offered('onOpen'));
    expect(choices('defaultDataBits')).toEqual(offered('dataBits'));
    expect(choices('defaultStopBits')).toEqual(offered('stopBits'));
    // The titles are words for a person, not the raw values.
    expect(choices('defaultOnOpen')).toContainEqual(['pulse-dtr', 'Pulse DTR']);
    expect(choices('defaultParity')).toContainEqual(['none', 'None']);
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-164 the baud rate field is a text field with the input mode numeric', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    const baud = control(dialog.body.node, 'baudRate') as HTMLInputElement;

    // DEF-PANEL-6: the arrow keys and the mouse wheel change a number field by 1.
    expect(baud.tagName).toBe('INPUT');
    expect(baud.type).toBe('text');
    expect(baud.getAttribute('inputmode')).toBe('numeric');
    expect(baud.getAttribute('aria-label')).toBe('Baud rate');
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-232 the settings body is a table of six rows, each with a row head and one control in its value cell', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    const table = one(dialog.body.node, 'table');
    const body = one(table, 'tbody');
    const rows = Array.from(body.querySelectorAll('tr'));

    expect(rows).toHaveLength(6);
    expect(rows.map(row => one(row, 'th').textContent)).toEqual([
      'Config',
      'Baud rate',
      'Data bits',
      'Parity',
      'Stop bits',
      'When a program opens the port'
    ]);
    expect(
      rows.every(row => one(row, 'th').getAttribute('scope') === 'row')
    ).toBe(true);
    // Every value cell holds one control, the same kind of control in every row.
    expect(
      rows.map(row => {
        const controls = one(row, 'td').querySelectorAll('input, select');
        expect(controls).toHaveLength(1);
        expect(
          controls[0].classList.contains('jp-DeviceBridgePanel-input')
        ).toBe(true);
        return controls[0].getAttribute('data-setting-field');
      })
    ).toEqual([
      'config',
      'baudRate',
      'dataBits',
      'parity',
      'stopBits',
      'onOpen'
    ]);
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-232 each value cell holds one field wrapper with the control, and the baud rate group sits in its cell', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    const rows = Array.from(
      dialog.body.node.querySelectorAll(
        '.jp-DeviceBridgeSettings-table tbody tr'
      )
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const cell = one(row, 'td');
      const field = one(cell, '.jp-DeviceBridgeSettings-field');
      expect(field.parentElement).toBe(cell);
      expect(field.querySelectorAll('input, select')).toHaveLength(1);
    }
    // The input and the list button are the one group in the baud cell.
    const baud = control(dialog.body.node, 'baudRate');
    const group = baudGroup(dialog.body.node);
    const field = baud.closest('.jp-DeviceBridgeSettings-field')!;
    expect(field.parentElement?.tagName).toBe('TD');
    expect(group.parentElement).toBe(field);
    expect(group.querySelectorAll('input')).toHaveLength(1);
    expect(group.querySelectorAll('button')).toHaveLength(1);
    // No datalist and no Custom badge remain.
    expect(dialog.body.node.querySelector('datalist')).toBeNull();
    expect(dialog.body.node.querySelector('[data-setting-badge]')).toBeNull();
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-235 the baud rate is an editable input joined to a button that opens the sixteen standard rates in a menu, and a chosen rate fills the input', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);
    const baud = control(dialog.body.node, 'baudRate') as HTMLInputElement;
    const group = baudGroup(dialog.body.node);
    const toggle = baudToggle(dialog.body.node);

    expect(group.contains(baud)).toBe(true);
    expect(group.contains(toggle)).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Standard baud rates');
    expect(baud.getAttribute('list')).toBeNull();
    expect(baud.getAttribute('aria-expanded')).toBe('false');

    // The menu is a widget of the page body, so the dialog cannot clip it.
    expect(document.body.querySelector('.lm-Menu')).toBeNull();
    toggle.click();
    const menu = one(document.body, '.jp-DeviceBridgeSettings-baudMenu');
    expect(menu.classList.contains('lm-Menu')).toBe(true);
    expect(baud.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(menu.querySelectorAll('li.lm-Menu-item'));
    expect(items.map(item => item.textContent)).toEqual([
      '300',
      '600',
      '1200',
      '2400',
      '4800',
      '9600',
      '14400',
      '19200',
      '28800',
      '38400',
      '57600',
      '74880',
      '115200',
      '230400',
      '460800',
      '921600'
    ]);
    expect(items.some(item => item.textContent === 'Custom')).toBe(false);

    // Choosing a rate writes it into the input, closes the list and returns focus.
    pick('device-bridge:baud-rate-9600');
    expect(baud.value).toBe('9600');
    expect(document.body.querySelector('.lm-Menu')).toBeNull();
    expect(document.activeElement).toBe(baud);
    expect(baud.getAttribute('aria-expanded')).toBe('false');
    expect(
      (control(dialog.body.node, 'config') as HTMLSelectElement).value
    ).toBe('');

    // A typed rate stays as typed; the input is editable at all times.
    choose(dialog.body.node, 'baudRate', '250000');
    expect(baud.value).toBe('250000');
    await dialog.close('Cancel');
  });

  it('ACC-PANEL-221 the baud rate is one editable field, and a standard value and a typed value both reach the request', async () => {
    const all = await labWithConfigs();
    const serialRow = row(all, UNO_NAME);
    const dialog = await openSettings(all, UNO_NAME);
    const baud = control(dialog.body.node, 'baudRate');

    expect(baud.tagName).toBe('INPUT');
    expect((baud as HTMLInputElement).type).toBe('text');
    expect(baud.value).toBe('115200');

    // A standard value is typed in, and the change selects Custom in the Config
    // select as every other field does.
    choose(dialog.body.node, 'config', 'monitor');
    expect(control(dialog.body.node, 'config').value).toBe('monitor');
    choose(dialog.body.node, 'baudRate', '9600');
    expect(control(dialog.body.node, 'config').value).toBe('');
    await dialog.close('Save');
    expect(all.changes).toEqual([{ baudRate: 9600 }]);
    expect(text(serialRow, 'baud')).toBe('9600');

    // A typed rate outside the standard list reaches the request as well.
    const second = await openSettings(all, UNO_NAME);
    expect(control(second.body.node, 'baudRate').value).toBe('9600');
    choose(second.body.node, 'config', 'monitor');
    choose(second.body.node, 'baudRate', '250000');
    expect(control(second.body.node, 'config').value).toBe('');
    await second.close('Save');

    expect(all.changes[all.changes.length - 1]).toEqual({ baudRate: 250000 });
    expect(text(serialRow, 'baud')).toBe('250000');

    // The next dialog shows the typed rate in the one field.
    const third = await openSettings(all, UNO_NAME);
    expect(control(third.body.node, 'baudRate').value).toBe('250000');
    await third.close('Cancel');
  });

  it('ACC-PANEL-222 Save carries jp-mod-accept and Delete config jp-mod-warn; Cancel and Save as... carry no accent, and Save is the one accent button', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    expect(
      dialog.buttons.map(shown => [shown.label, buttonClass(shown)])
    ).toEqual([
      [
        'Delete config',
        'jp-Dialog-button jp-mod-accept jp-mod-warn jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-danger'
      ],
      [
        'Cancel',
        'jp-Dialog-button jp-mod-reject jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-secondary'
      ],
      [
        'Save as...',
        'jp-Dialog-button jp-mod-reject jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-secondary'
      ],
      [
        'Save',
        'jp-Dialog-button jp-mod-accept jp-DeviceBridgeSettings-button jp-DeviceBridgeSettings-primary'
      ]
    ]);
    // The lab's warn button keeps the accept flag, so an accent button is an accept
    // button without the warning class.
    expect(
      dialog.buttons
        .filter(shown => {
          const names = buttonClass(shown).split(' ');
          return (
            names.includes('jp-mod-accept') && !names.includes('jp-mod-warn')
          );
        })
        .map(shown => shown.label)
    ).toEqual(['Save']);
    await dialog.close('Cancel');
  });

  it('ACC-PROF-207 Save sends the changed fields in one settings request, numbers as numbers, and the row shows the new baud rate and custom', async () => {
    const all = await labWithConfigs();
    const serialRow = row(all, UNO_NAME);
    const dialog = await openSettings(all, UNO_NAME);

    choose(dialog.body.node, 'baudRate', '9600');
    choose(dialog.body.node, 'parity', 'even');
    expect(all.changes).toEqual([]);
    await dialog.close('Save');

    const [request] = all.fetch.mock.calls[0] as [Request];
    expect(request.method).toBe('PUT');
    expect(request.url.split('?')[0]).toBe(
      `http://lab.test/jupyterlab-device-bridge-extension/serial/${UNO_NAME}/settings`
    );
    expect(all.changes).toEqual([{ baudRate: 9600, parity: 'even' }]);
    expect(text(serialRow, 'baud')).toBe('9600');
    expect(text(serialRow, 'config')).toBe('custom');
    expect(emit).not.toHaveBeenCalled();
  });

  it('ACC-PROF-207 data bits, stop bits and the action on open are sent with Save, numbers as numbers, and the next dialog shows them', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    choose(dialog.body.node, 'dataBits', '7');
    choose(dialog.body.node, 'stopBits', '2');
    choose(dialog.body.node, 'onOpen', 'esp-bootloader');
    await dialog.close('Save');

    expect(all.changes).toEqual([
      { dataBits: 7, stopBits: 2, onOpen: 'esp-bootloader' }
    ]);
    expect(all.server.table.serial[0].configured).toEqual({
      baudRate: 115200,
      dataBits: 7,
      parity: 'none',
      stopBits: 2,
      onOpen: 'esp-bootloader'
    });
    expect(values(await openSettings(all, UNO_NAME))).toEqual([
      'config=',
      'baudRate=115200',
      'dataBits=7',
      'parity=none',
      'stopBits=2',
      'onOpen=esp-bootloader'
    ]);
  });

  it('ACC-PANEL-164 Cancel sends nothing and the row keeps 115200, also after the fields were changed', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    choose(dialog.body.node, 'baudRate', '9600');
    choose(dialog.body.node, 'config', 'stm32-bootloader');
    await dialog.close('Cancel');

    expect(all.changes).toEqual([]);
    expect(all.fetch).not.toHaveBeenCalled();
    expect(text(row(all, UNO_NAME), 'baud')).toBe('115200');
    expect(text(row(all, UNO_NAME), 'config')).toBe('custom');
  });

  it('ACC-PANEL-164 Save with no field changed sends nothing', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);

    // A field changed and set back is no change.
    choose(dialog.body.node, 'parity', 'odd');
    choose(dialog.body.node, 'parity', 'none');
    await dialog.close('Save');

    expect(all.fetch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('ACC-PROF-207 choosing a config fills the fields and Save sends the config; changing one field selects Custom and sends that field', async () => {
    const all = await labWithConfigs();
    const serialRow = row(all, UNO_NAME);
    const dialog = await openSettings(all, UNO_NAME);

    choose(dialog.body.node, 'config', 'stm32-bootloader');

    // The config fills the fields with its five values.
    expect(values(dialog)).toEqual([
      'config=stm32-bootloader',
      'baudRate=115200',
      'dataBits=8',
      'parity=even',
      'stopBits=1',
      'onOpen=none'
    ]);
    await dialog.close('Save');

    expect(all.changes).toEqual([{ config: 'stm32-bootloader' }]);
    expect(text(serialRow, 'config')).toBe('STM32 bootloader');
    expect(text(serialRow, 'on-open')).toBe('Do nothing');
    expect(text(serialRow, 'baud')).toBe('115200');

    const second = await openSettings(all, UNO_NAME);
    choose(second.body.node, 'baudRate', '57600');
    await second.close('Save');

    expect(all.changes[all.changes.length - 1]).toEqual({ baudRate: 57600 });
    expect(text(serialRow, 'config')).toBe('custom');
    expect(text(serialRow, 'baud')).toBe('57600');
  });

  it('ACC-PROF-207 the dialog shows the configured values, not the baud rate a tool set on the port', async () => {
    const all = await labWithConfigs();
    const serialRow = row(all, UNO_NAME);
    Object.assign(all.server.table.serial[0], {
      configured: {
        baudRate: 115200,
        dataBits: 8,
        parity: 'even',
        stopBits: 1,
        onOpen: 'pulse-dtr'
      },
      config: 'stm32-bootloader',
      configName: 'STM32 bootloader',
      // A tool holds the virtual device and has set 57600 baud on it.
      holder: { pid: 7, name: 'stm32flash' },
      settings: { baudRate: 57600, dataBits: 8, parity: 'even', stopBits: 1 }
    });
    all.server.push();
    await tick();

    expect(text(serialRow, 'baud')).toBe('57600');
    expect(values(await openSettings(all, UNO_NAME))).toEqual([
      'config=stm32-bootloader',
      'baudRate=115200',
      'dataBits=8',
      'parity=even',
      'stopBits=1',
      'onOpen=pulse-dtr'
    ]);
  });

  it('ACC-PROF-205 Save as... stores the values under a name, applies the saved config and reads the list again', async () => {
    const all = await labWithConfigs();
    const dialog = await openSettings(all, UNO_NAME);
    choose(dialog.body.node, 'baudRate', '57600');
    choose(dialog.body.node, 'onOpen', 'pulse-rts');

    await dialog.close('Save as...');

    const prompt = dialogs[dialogs.length - 1];
    (
      prompt.body.node.querySelector(
        '[data-setting-field="name"]'
      ) as HTMLInputElement
    ).value = 'My board';
    await prompt.close('Save');

    expect(all.savedConfigs).toEqual([
      {
        name: 'My board',
        baudRate: 57600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        onOpen: 'pulse-rts'
      }
    ]);
    expect(all.changes).toEqual([{ config: 'config-1' }]);
    expect(all.server.configs.some(item => item.id === 'config-1')).toBe(true);
  });

  it('ACC-PROF-205 Delete config removes the user-saved config the port uses', async () => {
    const saved: ISettingsConfig = {
      id: 'config-1',
      name: 'My board',
      system: false,
      baudRate: 57600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      onOpen: 'pulse-rts'
    };
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      prepare: server => {
        server.configs.push(saved);
      }
    });
    serveSettings(all);
    Object.assign(all.server.table.serial[0], {
      configured: {
        baudRate: 57600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        onOpen: 'pulse-rts'
      },
      config: saved.id,
      configName: saved.name
    });
    all.server.push();
    await tick();

    const dialog = await openSettings(all, UNO_NAME);
    await dialog.close('Delete config');

    expect(all.deleted).toEqual([
      '/jupyterlab-device-bridge-extension/settings-configs/config-1'
    ]);
    expect(
      all.server.configs.find(item => item.id === 'config-1')
    ).toBeUndefined();
  });

  it('ACC-PROF-207 the Serial and USB header has the help link, and each click asks for the help document', async () => {
    const all = await labWithConfigs();
    const help = action(all.panel.node, 'settings-help');

    expect(help.textContent).toBe('help');
    help.click();
    await tick();
    help.click();
    await tick();

    expect(all.handlers.showHelp).toHaveBeenCalledTimes(2);
    // The document is a tab of the main area, not a dialog of the lab.
    expect(showDialog).not.toHaveBeenCalled();
    expect(dialogs).toEqual([]);
  });

  it('ACC-PANEL-164 ACC-PANEL-175 a change the server refuses raises the notification Settings not changed with the message of the server, and the row keeps its values', async () => {
    const all = await labWithConfigs();
    const refusal = {
      error: {
        code: 400,
        message: 'baudRate: 0 is not a whole number from 1 to 4294967295'
      }
    };
    all.answer = () => new Response(JSON.stringify(refusal), { status: 400 });
    const dialog = await openSettings(all, UNO_NAME);

    choose(dialog.body.node, 'baudRate', '');
    await dialog.close('Save');

    expect(all.changes).toEqual([{ baudRate: 0 }]);
    expect(emit.mock.calls).toEqual([
      [
        'Settings not changed: baudRate: 0 is not a whole number from 1 to 4294967295',
        'error',
        { autoClose: false }
      ]
    ]);
    expect(text(row(all, UNO_NAME), 'baud')).toBe('115200');
  });
});

describe('DeviceBridgePanel: the plus icon of the header', () => {
  it('ACC-PANEL-153 the header holds the title and one plus icon button with the add icon of the lab, and the panel has no add buttons', async () => {
    const all = await lab();
    const header = one(all.panel.node, '.jp-DeviceBridgePanel-header');
    const add = plus(all);

    expect(Array.from(header.children, child => child.tagName)).toEqual([
      'SPAN',
      'BUTTON'
    ]);
    expect(header.lastElementChild === add).toBe(true);
    expect(add.type).toBe('button');
    expect(add.className).toBe('jp-DeviceBridgePanel-iconButton');
    expect(add.textContent).toBe('');
    expect(one(add, 'svg').dataset.icon).toBe('ui-components:add');

    for (const gone of [
      '[data-action="connect-serial"]',
      '[data-action="connect-usb"]',
      '.jp-DeviceBridgePanel-toolbar'
    ]) {
      expect(all.panel.node.querySelector(gone)).toBeNull();
    }
    // The tooltip of the empty list names the icon and no button.
    expect(
      one(
        all.panel.node,
        '[data-section="devices"] .jp-DeviceBridgePanel-empty'
      ).title
    ).toBe(
      'No device yet. Add a serial port or a USB device of this computer with the plus icon above.'
    );
  });

  it('ACC-PANEL-153 a click on the plus icon opens the menu at the left edge and the bottom edge of the icon, with one entry per connect command', async () => {
    const all = await lab();
    const add = plus(all);
    add.getBoundingClientRect = () =>
      ({ left: 40, right: 64, top: 4, bottom: 28 }) as DOMRect;
    const open = jest.spyOn(all.addMenu, 'open');

    expect(menuOpen()).toBe(false);
    add.click();

    expect(open.mock.calls).toEqual([[40, 28]]);
    expect(menuOpen()).toBe(true);
    expect(all.addMenu.isAttached).toBe(true);
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('li.lm-Menu-item'),
        entry => entry.dataset.command
      )
    ).toEqual([CONNECT_SERIAL, CONNECT_USB]);
    // The menu alone runs no command.
    expect(all.handlers.connectSerial).not.toHaveBeenCalled();
    expect(all.handlers.connectUsb).not.toHaveBeenCalled();

    all.addMenu.close();
  });

  it('ACC-PANEL-153 an entry of the plus menu runs its command once and not the other command, and the menu closes', async () => {
    const all = await lab();

    plus(all).click();
    pick(CONNECT_SERIAL);

    expect(all.handlers.connectSerial).toHaveBeenCalledTimes(1);
    expect(all.handlers.connectUsb).not.toHaveBeenCalled();
    expect(menuOpen()).toBe(false);

    plus(all).click();
    pick(CONNECT_USB);

    expect(all.handlers.connectUsb).toHaveBeenCalledTimes(1);
    expect(all.handlers.connectSerial).toHaveBeenCalledTimes(1);
    expect(menuOpen()).toBe(false);
    // The panel itself opens no dialog of the browser.
    expect(all.serial.dialogs).toEqual([]);
    expect(all.usb.dialogs).toEqual([]);
  });

  it('ACC-PANEL-156 the title of the plus icon says what it adds, and the icon says that it opens a menu', async () => {
    const all = await lab();

    expect(plus(all).title).toBe('Add a serial port or a USB device');
    expect(plus(all).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('ACC-PANEL-156 the open menu has the focus, Escape closes it, and the focus is on the plus icon again', async () => {
    const all = await lab();
    const add = plus(all);

    add.focus();
    add.click();
    // Lumino gives the open menu the focus when it handles its next posted message.
    MessageLoop.flush();
    expect(document.activeElement === all.addMenu.node).toBe(true);

    pressEscape(all);

    expect(menuOpen()).toBe(false);
    expect(document.activeElement === add).toBe(true);
  });

  it('ACC-PANEL-156 the focus is on the plus icon again after an entry of the menu was chosen', async () => {
    const all = await lab();
    const add = plus(all);

    add.click();
    expect(document.activeElement === add).toBe(false);
    pick(CONNECT_USB);

    expect(all.handlers.connectUsb).toHaveBeenCalledTimes(1);
    expect(document.activeElement === add).toBe(true);
  });

  it('ACC-PANEL-156 a disposed panel is not touched when the menu closes: its plus icon gets no focus call', async () => {
    const all = await lab();
    const focus = jest.spyOn(plus(all), 'focus');

    plus(all).click();
    pressEscape(all);
    expect(focus).toHaveBeenCalledTimes(1);

    all.panel.dispose();
    all.addMenu.open(0, 0);
    expect(menuOpen()).toBe(true);
    all.addMenu.close();

    expect(menuOpen()).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceBridgePanel: buttons that go to the plugin', () => {
  it('ACC-TERM-74 the Terminal button of a serial row calls the terminal handler with the name of the port', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });

    action(row(all, UNO_NAME), 'terminal').click();

    expect(all.handlers.openTerminal.mock.calls).toEqual([[UNO_NAME]]);
  });

  it('ACC-USB-47 a device request shows the program, the vendor and product id and the reason, and goes when it is answered', async () => {
    const all = await lab();
    const section = one(all.panel.node, '[data-section="requests"]');

    expect(section.hidden).toBe(true);
    expect(all.panel.node.querySelector('[data-request]')).toBeNull();

    all.server.pending.push(PROBE_REQUEST, {
      id: 'request-2',
      kind: 'serial',
      reason: 'read the log',
      program: 'agent'
    });
    all.server.push();
    await tick();

    const first = one(all.panel.node, '[data-request="request-1"]');
    const second = one(all.panel.node, '[data-request="request-2"]');
    expect(section.hidden).toBe(false);
    expect(text(section, 'count')).toBe('(2)');
    expect(text(first, 'program')).toBe('pyocd');
    expect(text(first, 'device')).toBe(
      'USB device with vendor id 0d28 and product id 0204'
    );
    expect(text(first, 'reason')).toBe('flash the board');
    expect(text(second, 'program')).toBe('agent');
    expect(text(second, 'device')).toBe('serial port');
    expect(text(second, 'reason')).toBe('read the log');

    all.server.pending.splice(0, 2);
    all.server.push();
    await tick();
    expect(all.panel.node.querySelector('[data-request]')).toBeNull();
    expect(section.hidden).toBe(true);
  });

  it('ACC-USB-47 the words for the requested device name the kind and each id the program gave, in 4 hex digits', () => {
    const request = { id: 'r', reason: 'why', program: 'tool' };

    expect(
      requestedDevice({ ...request, kind: 'serial', vendorId: 0x2341 })
    ).toBe('serial port with vendor id 2341');
    expect(requestedDevice({ ...request, kind: 'usb', productId: 0x1 })).toBe(
      'USB device with product id 0001'
    );
    expect(
      requestedDevice({ ...request, kind: 'usb', vendorId: 0, productId: 0 })
    ).toBe('USB device with vendor id 0000 and product id 0000');
    expect(requestedDevice({ ...request, kind: 'usb' })).toBe('USB device');
  });

  it('ACC-USB-48 the Grant button of a request calls the grant handler of the plugin with the id of the request', async () => {
    const all = await lab();
    all.server.pending.push(PROBE_REQUEST);
    all.server.push();
    await tick();

    action(one(all.panel.node, '[data-request="request-1"]'), 'grant').click();

    expect(all.handlers.grantRequest.mock.calls).toEqual([['request-1']]);
    expect(all.usb.dialogs).toEqual([]);
  });
});

describe('DeviceBridgePanel: the runs section', () => {
  /** Make the server list these runs and no other, and tell the tab. */
  async function run(all: ILab, ...runs: IRunRecord[]): Promise<void> {
    all.server.running.splice(0, all.server.running.length, ...runs);
    all.server.pushRuns();
    await tick();
  }

  const runsSection = (all: ILab): HTMLElement =>
    one(all.panel.node, '[data-section="runs"]');

  const runRow = (all: ILab, pid: number): HTMLElement =>
    one(all.panel.node, `[data-run="${pid}"]`);

  /** The process ids of the run rows, in the order of the panel. */
  const runRows = (all: ILab): Array<string | undefined> =>
    Array.from(
      all.panel.node.querySelectorAll<HTMLElement>('[data-run]'),
      node => node.dataset.run
    );

  it('ACC-PANEL-131 the runs section has its title, the count of the runs and one row per run with program, process id, command line and device', async () => {
    const all = await lab();
    const section = runsSection(all);

    expect(one(section, '.jp-DeviceBridgePanel-sectionTitle').textContent).toBe(
      'Device shells'
    );

    await run(all, SHELL_RUN, UPLOAD_RUN);

    expect(text(section, 'count')).toBe('(2)');
    expect(runRows(all)).toEqual(['4242', '4250']);
    expect(section.querySelectorAll('[data-run]')).toHaveLength(2);

    const shell = runRow(all, 4242);
    expect(text(shell, 'program')).toBe('bash');
    expect(text(shell, 'pid')).toBe('pid 4242');
    expect(text(shell, 'command')).toBe('/bin/bash');
    expect(text(shell, 'device')).toBe('no device');

    const upload = runRow(all, 4250);
    expect(text(upload, 'program')).toBe('avrdude');
    expect(text(upload, 'pid')).toBe('pid 4250');
    expect(text(upload, 'command')).toBe(UPLOAD_RUN.command);
    expect(text(upload, 'device')).toBe(UNO_NAME);
  });

  it('ACC-PANEL-131 the device of a run row is the device the run names, else the serial port that the process of the run holds, else no device', async () => {
    const all = await lab({ ports: [new SimSerialPort(UNO)] });
    const unnamed = { ...UPLOAD_RUN, device: null };
    await run(all, SHELL_RUN, unnamed);
    const upload = runRow(all, 4250);

    expect(text(upload, 'device')).toBe('no device');

    // The tool opens the virtual device. The server sends the device table for that,
    // and no list of the runs.
    all.server.table.serial[0].holder = { pid: 4250, name: 'avrdude' };
    all.server.push();
    await tick();

    expect(text(upload, 'device')).toBe(UNO_NAME);
    expect(text(runRow(all, 4242), 'device')).toBe('no device');

    // The device a run names comes before the port its process holds.
    await run(all, SHELL_RUN, { ...UPLOAD_RUN, device: 'tty-0403-6001' });
    expect(text(upload, 'device')).toBe('tty-0403-6001');

    // The tool closes the virtual device.
    await run(all, SHELL_RUN, unnamed);
    expect(text(upload, 'device')).toBe(UNO_NAME);
    all.server.table.serial[0].holder = null;
    all.server.push();
    await tick();

    expect(text(upload, 'device')).toBe('no device');
  });

  it('ACC-PANEL-131 with no run the section shows its empty text and the count 0, also before the page got a list of the runs', async () => {
    const all = newLab({
      prepare: server => {
        server.running.push(SHELL_RUN);
      }
    });
    const section = runsSection(all);
    const empty = field(section, 'empty');

    // The worker has sent the server nothing yet, so the page has no message of the server.
    expect(all.server.received).toEqual([]);
    expect(all.model.tabId).toBeNull();
    expect(section.hidden).toBe(false);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe('No device shell opened');
    expect(text(section, 'count')).toBe('(0)');
    expect(runRows(all)).toEqual([]);

    // The server answers: it lists one run.
    await tick();

    expect(empty.hidden).toBe(true);
    expect(text(section, 'count')).toBe('(1)');
    expect(runRows(all)).toEqual(['4242']);

    await run(all);
    // The row of the run that just ended stays for the rest of RUN_VISIBLE_MS.
    await tick(RUN_VISIBLE_MS);

    expect(empty.hidden).toBe(false);
    expect(text(section, 'count')).toBe('(0)');
    expect(runRows(all)).toEqual([]);
  });

  it('ACC-PANEL-131 while the WebSocket is closed the section shows no run and no Info button, and the run has its row again when the server lists it', async () => {
    const all = await lab();
    await run(all, SHELL_RUN);
    const section = runsSection(all);
    expect(runRows(all)).toEqual(['4242']);

    all.server.accepting = false;
    all.server.drop();

    expect(runRows(all)).toEqual([]);
    expect(text(section, 'count')).toBe('(0)');
    expect(field(section, 'empty').hidden).toBe(false);
    expect(action(section, 'run-info').hidden).toBe(true);

    // The worker connects again after 0.5 s, and the server lists its runs.
    all.server.accepting = true;
    await tick(500);

    expect(runRows(all)).toEqual(['4242']);
    expect(field(section, 'empty').hidden).toBe(true);
    expect(action(section, 'run-info').hidden).toBe(false);
  });

  it('ACC-PANEL-131 a run that ended leaves the section, a run that lives keeps its row, and a row shows the newest record of its process id', async () => {
    const all = await lab();
    await run(all, SHELL_RUN, UPLOAD_RUN);
    const shell = runRow(all, 4242);

    await run(all, SHELL_RUN);
    // The row of the run that just ended stays for the rest of RUN_VISIBLE_MS.
    await tick(RUN_VISIBLE_MS);

    expect(runRows(all)).toEqual(['4242']);
    expect(runRow(all, 4242) === shell).toBe(true);

    // A second registration of a process id replaces the record.
    await run(all, { ...SHELL_RUN, program: 'zsh', command: '/bin/zsh -l' });

    expect(runRow(all, 4242) === shell).toBe(true);
    expect(text(shell, 'program')).toBe('zsh');
    expect(text(shell, 'command')).toBe('/bin/zsh -l');
  });

  it('ACC-PANEL-140 the runs section is titled Device shells, its Start button has the title Open a device shell, and its empty text names a device shell; the buttons keep the labels Start and Info', async () => {
    const all = await lab();
    const section = runsSection(all);

    expect(one(section, '.jp-DeviceBridgePanel-sectionTitle').textContent).toBe(
      'Device shells'
    );
    expect(action(section, 'start-run').title).toBe('Open a device shell');
    expect(action(section, 'start-run').textContent).toBe('Start');
    expect(action(section, 'run-info').textContent).toBe('Info');
    expect(field(section, 'empty').textContent).toBe('No device shell opened');
    expect(field(section, 'empty').title).toBe(
      'No device shell is open. Start opens a terminal in which tools control the lines of the serial ports.'
    );
  });

  it('ACC-PANEL-132 the Start button of the runs section calls the start handler of the plugin once per click, with a run and without one', async () => {
    const all = await lab();
    const start = action(runsSection(all), 'start-run');

    expect(start.textContent).toBe('Start');
    expect(start.hidden).toBe(false);
    start.click();
    expect(all.handlers.startRun).toHaveBeenCalledTimes(1);

    await run(all, SHELL_RUN);
    expect(start.hidden).toBe(false);
    start.click();

    expect(all.handlers.startRun).toHaveBeenCalledTimes(2);
    expect(all.handlers.showRunInfo).not.toHaveBeenCalled();
    expect(all.stops).toEqual([]);
  });

  it('ACC-PANEL-133 Stop asks for a second click, then sends DELETE runs/<pid>, and the row stays until the server lists the run no more', async () => {
    const all = await lab();
    await run(all, SHELL_RUN, UPLOAD_RUN);
    const stop = action(runRow(all, 4250), 'stop-run');

    expect(stop.textContent).toBe('Stop');
    expect(stop.classList.contains('jp-mod-confirm')).toBe(false);

    stop.click();
    await tick();
    expect(stop.textContent).toBe('Confirm stop');
    expect(stop.classList.contains('jp-mod-confirm')).toBe(true);
    expect(all.stops).toEqual([]);

    // The second click of a double click comes too early and does nothing.
    stop.click();
    await tick(ARM_DELAY_MS - 1);
    expect(all.stops).toEqual([]);
    expect(stop.textContent).toBe('Confirm stop');

    await tick(1);
    stop.click();
    await tick();
    expect(all.stops).toEqual([
      'DELETE /jupyterlab-device-bridge-extension/runs/4250'
    ]);
    expect(stop.textContent).toBe('Stop');
    expect(emit).not.toHaveBeenCalled();
    // The server answered 204 after it sent the signal: the process still ends.
    expect(runRows(all)).toEqual(['4242', '4250']);

    // The server saw the process gone. Its row stays for the rest of RUN_VISIBLE_MS.
    await run(all, SHELL_RUN);
    await tick(RUN_VISIBLE_MS);
    expect(runRows(all)).toEqual(['4242']);
    expect(all.stops).toHaveLength(1);
  });

  it('ACC-PANEL-133 an armed Stop stays armed while the server sends the device table and the runs again, and goes back to Stop when the focus leaves it', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    await run(all, UPLOAD_RUN);
    const stop = action(runRow(all, 4250), 'stop-run');

    stop.focus();
    stop.click();
    // The byte counters of the port change during an upload: the table comes again.
    port.receive([1, 2, 3]);
    await tick(1000);
    all.server.pushRuns();
    await tick();

    expect(text(row(all, UNO_NAME), 'rx')).toBe('3 bytes');
    expect(action(runRow(all, 4250), 'stop-run') === stop).toBe(true);
    expect(stop.textContent).toBe('Confirm stop');

    stop.blur();
    expect(stop.textContent).toBe('Stop');
    stop.click();
    await tick();
    expect(stop.textContent).toBe('Confirm stop');
    expect(all.stops).toEqual([]);

    await tick(ARM_DELAY_MS);
    stop.click();
    await tick();
    expect(all.stops).toEqual([
      'DELETE /jupyterlab-device-bridge-extension/runs/4250'
    ]);
  });

  it('ACC-PANEL-133 ACC-PANEL-175 a stop that the server refuses raises the notification Not stopped that stays, with the reason of the server last', async () => {
    const all = await lab();
    await run(all, UPLOAD_RUN);
    const refusal = {
      error: { code: 'unknown-run', message: 'No run has the pid 4250' }
    };
    all.stopAnswer = () =>
      new Response(JSON.stringify(refusal), { status: 404 });
    const stop = action(runRow(all, 4250), 'stop-run');

    stop.click();
    await tick(ARM_DELAY_MS);
    stop.click();
    await tick();

    expect(all.stops).toHaveLength(1);
    expect(emit.mock.calls).toEqual([
      ['Not stopped: No run has the pid 4250', 'error', { autoClose: false }]
    ]);
    expect(runRows(all)).toEqual(['4250']);
  });

  it('ACC-PANEL-216 a click on the Copy button of a run row copies the command line the row shows', async () => {
    const all = await lab();
    await run(all, SHELL_RUN, UPLOAD_RUN);
    const copyToSystem = Clipboard.copyToSystem as jest.Mock;
    copyToSystem.mockClear();

    const upload = runRow(all, 4250);
    const copy = action(upload, 'copy-run');
    expect(copy.textContent).toBe('Copy');
    expect(copy.title).toBe(`Copy the command line: ${UPLOAD_RUN.command}`);

    copy.click();
    expect(copyToSystem).toHaveBeenCalledTimes(1);
    expect(copyToSystem).toHaveBeenLastCalledWith(UPLOAD_RUN.command);

    // Each row copies its own command line.
    action(runRow(all, 4242), 'copy-run').click();
    expect(copyToSystem).toHaveBeenLastCalledWith('/bin/bash');

    // A second registration of the process id changes the command line of the row,
    // and the button copies what the row shows now.
    const changed = {
      ...UPLOAD_RUN,
      command: 'avrdude -c arduino -p atmega328p'
    };
    await run(all, SHELL_RUN, changed);
    expect(text(upload, 'command')).toBe(changed.command);
    expect(copy.title).toBe(`Copy the command line: ${changed.command}`);
    copy.click();
    expect(copyToSystem).toHaveBeenLastCalledWith(changed.command);
  });

  it('ACC-PANEL-223 a click on Copy changes the button to Copied, and it reads Copy again after 1.5 s', async () => {
    const all = await lab();
    await run(all, UPLOAD_RUN);
    const copyToSystem = Clipboard.copyToSystem as jest.Mock;
    copyToSystem.mockClear();
    const copy = action(runRow(all, 4250), 'copy-run');
    expect(copy.textContent).toBe('Copy');

    copy.click();
    expect(copyToSystem).toHaveBeenLastCalledWith(UPLOAD_RUN.command);
    expect(copy.textContent).toBe('Copied');

    await tick(COPIED_MS - 1);
    expect(copy.textContent).toBe('Copied');
    await tick(1);
    expect(copy.textContent).toBe('Copy');
  });

  it('ACC-PANEL-224 a run removed 0.5 s after it appeared stays until 3 s, then leaves, and a run that lasted longer leaves at once', async () => {
    const all = await lab();
    await run(all, UPLOAD_RUN);
    const upload = runRow(all, 4250);

    // The run ends 0.5 s after it appeared.
    await tick(500);
    await run(all);
    expect(runRows(all)).toEqual(['4250']);
    expect(runRow(all, 4250) === upload).toBe(true);
    expect(text(upload, 'state')).toBe('stopped');

    // It stays until 3 s after its first appearance.
    await tick(RUN_VISIBLE_MS - 500 - 1);
    expect(runRows(all)).toEqual(['4250']);
    await tick(1);
    expect(runRows(all)).toEqual([]);
    expect(upload.isConnected).toBe(false);

    // A run that lasted longer than 3 s leaves when the server drops it.
    await run(all, SHELL_RUN);
    await tick(RUN_VISIBLE_MS);
    const shell = runRow(all, 4242);
    await run(all);
    expect(runRows(all)).toEqual([]);
    expect(shell.isConnected).toBe(false);
  });

  it('ACC-PANEL-225 a run removed from the server table keeps a stopped state and a disabled Stop on its lingering row, and Copy and Info stay usable', async () => {
    const all = await lab();
    await run(all, SHELL_RUN);
    const section = runsSection(all);
    const shell = runRow(all, 4242);
    const stop = action(shell, 'stop-run');
    const copy = action(shell, 'copy-run');
    const info = action(section, 'run-info');

    // The user clicked Stop once: the button is armed.
    stop.click();
    expect(stop.textContent).toBe('Confirm stop');
    expect(stop.classList.contains('jp-mod-confirm')).toBe(true);

    await run(all);

    expect(runRow(all, 4242) === shell).toBe(true);
    expect(field(shell, 'state').hidden).toBe(false);
    expect(text(shell, 'state')).toBe('stopped');
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stop');
    expect(stop.classList.contains('jp-mod-confirm')).toBe(false);
    expect(copy.disabled).toBe(false);
    expect(info.hidden).toBe(false);

    // Copy acts on the lingering row.
    copy.click();
    await tick();
    expect(Clipboard.copyToSystem).toHaveBeenLastCalledWith(SHELL_RUN.command);

    // The row leaves 3 s after it appeared, and Info goes with it.
    await tick(RUN_VISIBLE_MS);
    expect(runRows(all)).toEqual([]);
    expect(info.hidden).toBe(true);
  });

  it('ACC-PANEL-134 the Info button is hidden while no run exists, also before the page got a list of the runs; with a run it is shown and calls the info handler of the plugin', async () => {
    const all = newLab();
    const info = action(runsSection(all), 'run-info');

    expect(info.textContent).toBe('Info');
    expect(all.server.received).toEqual([]);
    expect(info.hidden).toBe(true);

    await tick();
    expect(all.model.tabId).toBe('tab-1');
    expect(info.hidden).toBe(true);

    await run(all, SHELL_RUN);
    expect(info.hidden).toBe(false);
    info.click();
    expect(all.handlers.showRunInfo).toHaveBeenCalledTimes(1);
    expect(all.handlers.startRun).not.toHaveBeenCalled();

    await run(all);
    // The row of the run that just ended stays for the rest of RUN_VISIBLE_MS.
    await tick(RUN_VISIBLE_MS);
    expect(info.hidden).toBe(true);
  });
});

describe('DeviceBridgePanel: round trip and absent interfaces', () => {
  it('ACC-SERIAL-15 the round trip field shows the measured ms, and not connected while the WebSocket is closed', async () => {
    const all = await lab({
      prepare: server => {
        server.pongDelay = 12;
      }
    });
    const roundTrip = field(all.panel.node, 'round-trip');
    const footer = one(all.panel.node, '.jp-DeviceBridgePanel-footer');

    expect(roundTrip.textContent).toBe('not connected');
    expect(footer.textContent).toBe('Round trip: not connected');
    await tick(12);
    expect(roundTrip.textContent).toBe('12.0 ms');
    expect(footer.textContent).toBe('Round trip: 12.0 ms');

    all.server.accepting = false;
    all.server.drop();
    expect(roundTrip.textContent).toBe('not connected');
  });

  it('ACC-PANEL-154 without the device interfaces the panel names HTTPS and localhost, and the plus icon is disabled and opens no menu', async () => {
    const all = await lab({ interfaces: [] });
    const absent = field(all.panel.node, 'absent');

    expect(absent.hidden).toBe(false);
    expect(absent.textContent).toBe(
      'Web Serial and WebUSB need HTTPS or localhost, in Chrome or Edge'
    );
    expect(absent.title).toBe(
      'The browser gives this page no access to serial ports and USB devices. Open the lab over HTTPS or at localhost, in Chrome or Edge.'
    );
    expect(plus(all).disabled).toBe(true);

    plus(all).click();
    expect(menuOpen()).toBe(false);
  });

  it('ACC-PANEL-154 with both device interfaces the panel shows no such message, and the plus icon is enabled and opens its menu', async () => {
    const all = await lab();

    expect(field(all.panel.node, 'absent').hidden).toBe(true);
    expect(plus(all).disabled).toBe(false);

    plus(all).click();
    expect(menuOpen()).toBe(true);
    all.addMenu.close();
  });

  it.each([
    ['serial', 'WebUSB', 'USB devices'],
    ['usb', 'Web Serial', 'serial ports']
  ] as const)(
    'ACC-PANEL-154 ACC-PANEL-175 a browser with only the %s interface gets the message that %s needs HTTPS or localhost, with the full text in its tooltip, and the plus icon is enabled and opens its menu',
    async (only, name, missing) => {
      const all = await lab({ interfaces: [only] });
      const absent = field(all.panel.node, 'absent');

      expect(absent.hidden).toBe(false);
      expect(absent.textContent).toBe(
        `${name} needs HTTPS or localhost, in Chrome or Edge`
      );
      expect(absent.title).toBe(
        `The browser gives this page no access to ${missing}. Open the lab over HTTPS or at localhost, in Chrome or Edge.`
      );
      expect(plus(all).disabled).toBe(false);

      plus(all).click();
      expect(menuOpen()).toBe(true);
      all.addMenu.close();
    }
  );
});

describe('DeviceBridgePanel: the short texts', () => {
  /** The text of a line of a row: the element that holds this field. */
  const lineOf = (root: ParentNode, name: string): HTMLElement =>
    field(root, name).parentElement!;

  it('ACC-PANEL-175 the panel shows short texts, and each tooltip keeps the full text', async () => {
    const all = await lab({
      prepare: server => {
        server.pongDelay = 12;
      }
    });
    const section = (name: string): HTMLElement =>
      one(all.panel.node, `[data-section="${name}"]`);
    const title = (name: string): HTMLElement =>
      one(section(name), '.jp-DeviceBridgePanel-sectionTitle');
    const emptyDevices = one(section('devices'), '.jp-DeviceBridgePanel-empty');
    const footer = one(all.panel.node, '.jp-DeviceBridgePanel-footer');

    expect(
      one(all.panel.node, '.jp-DeviceBridgePanel-headerTitle').textContent
    ).toBe('Devices');
    expect(
      ['devices', 'runs', 'requests'].map(name => [
        title(name).textContent,
        title(name).title
      ])
    ).toEqual([
      ['Serial and USB', 'Serial ports and USB devices of this computer'],
      [
        'Device shells',
        'Device shells and tools started with jupyterlab-device run'
      ],
      ['Requests', 'Requests of programs in the container for a device']
    ]);
    expect([emptyDevices.textContent, emptyDevices.title]).toEqual([
      'No device attached',
      'No device yet. Add a serial port or a USB device of this computer with the plus icon above.'
    ]);
    const emptyRuns = field(section('runs'), 'empty');
    expect([emptyRuns.textContent, emptyRuns.title]).toEqual([
      'No device shell opened',
      'No device shell is open. Start opens a terminal in which tools control the lines of the serial ports.'
    ]);
    expect([footer.textContent, footer.title]).toEqual([
      'Round trip: not connected',
      'Round trip of a message from the browser to the server and back'
    ]);
    await tick(12);
    expect(footer.textContent).toBe('Round trip: 12.0 ms');

    // A port and a USB device, with traffic on the port.
    const port = new SimSerialPort(UNO);
    all.serial.dialog = port;
    await all.model.connectSerial();
    all.usb.dialog = new SimUsbDevice();
    await all.model.connectUsb();
    await tick();
    port.receive([1, 2, 3]);
    await tick(1000);

    const traffic = lineOf(row(all, UNO_NAME), 'rx');
    expect([traffic.textContent, traffic.title]).toEqual([
      'RX 3 bytes, TX 0 bytes',
      'Bytes from the device (RX) and to the device (TX)'
    ]);
    expect(lineOf(row(all, PROBE_NAME), 'rx').textContent).toBe(
      'RX 0 bytes, TX 0 bytes'
    );
    const opened = lineOf(row(all, PROBE_NAME), 'opened');
    expect([opened.textContent, opened.title]).toEqual([
      'Opened: no',
      'Whether a program in the container has the device open'
    ]);
    all.server.table.usb[0].opened = true;
    all.server.push();
    await tick();
    expect(opened.textContent).toBe('Opened: yes');
  });
});

describe('DeviceBridgePanel: the byte counters and their units', () => {
  it('ACC-PANEL-229 counts below 10 KB read bytes, with byte for 1', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(9999)).toBe('9999 bytes');
  });

  it('ACC-PANEL-229 counts from 10 KB to under 1 MB read kilobytes with one decimal', () => {
    expect(formatBytes(10000)).toBe('10.0 KB');
    expect(formatBytes(512300)).toBe('512.3 KB');
    expect(formatBytes(999899)).toBe('999.9 KB');
  });

  it('ACC-PANEL-229 counts from 1 MB read megabytes with one decimal', () => {
    expect(formatBytes(1000000)).toBe('1.0 MB');
    expect(formatBytes(12345678)).toBe('12.3 MB');
  });

  it('ACC-PANEL-229 a kilobyte count that rounds to 1000.0 reads as megabytes', () => {
    expect(formatBytes(999999)).toBe('1.0 MB');
  });

  it('ACC-PANEL-229 a device row shows the RX and TX counters with their units', async () => {
    const all = await lab({
      prepare: server => {
        server.table.serial.push({ ...HELD, rx: 10000, tx: 1000000 });
      }
    });
    const serialRow = row(all, UNO_NAME);

    expect(text(serialRow, 'rx')).toBe('10.0 KB');
    expect(text(serialRow, 'tx')).toBe('1.0 MB');
    expect(field(serialRow, 'rx').parentElement!.textContent).toBe(
      'RX 10.0 KB, TX 1.0 MB'
    );
  });
});

describe('DeviceBridgePanel: the help document', () => {
  /** The heading line of each section of the document, in order. */
  const headings = HELP_MARKDOWN.match(/^## .+$/gm) ?? [];

  /** The text under one heading, up to the next heading of the document, with the line breaks of the source folded. */
  const sectionText = (title: string): string => {
    const start = HELP_MARKDOWN.indexOf(`## ${title}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = HELP_MARKDOWN.slice(start);
    const next = rest.indexOf('\n## ', 1);
    return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ');
  };

  it('ACC-PANEL-227 each click on the help button calls showHelp once, and the panel opens no dialog', async () => {
    const all = await lab();
    const help = action(all.panel.node, 'settings-help');

    expect(
      all.panel.node.querySelector(
        '.jp-DeviceBridgePanel-sectionHeader [data-action="settings-help"]'
      )
    ).toBe(help);
    help.click();
    await tick();
    expect(all.handlers.showHelp).toHaveBeenCalledTimes(1);

    help.click();
    await tick();
    expect(all.handlers.showHelp).toHaveBeenCalledTimes(2);

    // The document is a tab of the main area, which the plugin opens, not a dialog.
    expect(showDialog).not.toHaveBeenCalled();
    expect(dialogs).toEqual([]);
  });

  it('ACC-PANEL-228 the document holds the four sections Options, Connections, Tools and Connection configs, in this order', () => {
    expect(headings).toEqual([
      '## Options',
      '## Connections',
      '## Tools',
      '## Connection configs'
    ]);
  });

  it('ACC-PANEL-228 each section explains its part: the panel options, the connections, the tools and the connection configs', () => {
    const options = sectionText('Options');
    for (const fact of [
      'showPanel',
      'showMenu',
      'defaultBaudRate',
      'defaultDataBits',
      'defaultParity',
      'defaultStopBits',
      'defaultOnOpen',
      'Serial and USB',
      'Requests',
      'Device shells',
      'Attach',
      'Detach',
      'Forget',
      'Start',
      'Info'
    ]) {
      expect(options).toContain(fact);
    }

    const connections = sectionText('Connections');
    for (const fact of [
      'grant',
      'Connect Serial Port',
      'Connect USB Device',
      'Attach',
      'Detach',
      'Forget',
      'attached',
      'detached',
      'held by another tab',
      'status bar item',
      'round trip'
    ]) {
      expect(connections).toContain(fact);
    }

    const tools = sectionText('Tools');
    for (const fact of [
      'Serial terminal',
      'Device shell',
      'Device shells',
      'Stop',
      'list',
      'status',
      'monitor read',
      'monitor write',
      'settings apply',
      'run --device',
      'probe avr',
      'probe stm32',
      'probe esp',
      'probe baud',
      'shell',
      'terminal'
    ]) {
      expect(tools).toContain(fact);
    }

    const configs = sectionText('Connection configs');
    for (const fact of [
      'Baud rate',
      'Data bits',
      'Parity',
      'Stop bits',
      'When a program opens the port',
      'Default',
      'Monitor',
      'Arduino upload',
      'Arduino as ISP',
      'STM32 bootloader',
      'ESP upload',
      'Save as...',
      'Delete config',
      'Pulse DTR',
      'Pulse RTS',
      'Enter the ESP bootloader',
      'Open at 1200 baud and close'
    ]) {
      expect(configs).toContain(fact);
    }
  });
});
