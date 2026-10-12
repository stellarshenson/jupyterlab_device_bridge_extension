/**
 * The Devices panel against the real model, the real worker function, simulated
 * devices and a simulated server.
 *
 * The tests read and click the panel through the hooks listed at the top of
 * `src/panel.ts`, as the functional tests do in a browser. The lab packages that Jest
 * cannot load are replaced: the notifications by a recorder, the icon by its SVG text.
 */

import { Notification } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';

import { Widget } from '@lumino/widgets';

import { DeviceBridgeModel } from '../model';
import { ARM_DELAY_MS, DeviceBridgePanel, requestedDevice } from '../panel';
import type {
  IDeviceRequest,
  IProfile,
  IProfileChange,
  ISerialRecord
} from '../protocol';
import { createWorker, workerMain } from '../worker';
import {
  SimScope,
  SimSerial,
  SimSerialPort,
  SimServer,
  SimUsb,
  SimUsbDevice
} from './sim';

jest.mock('@jupyterlab/apputils', () => ({
  Notification: { emit: jest.fn() }
}));
jest.mock('@jupyterlab/ui-components', () => ({
  LabIcon: class {
    constructor(readonly options: { name: string; svgstr: string }) {}
  }
}));
jest.mock('../worker', () => ({
  ...jest.requireActual('../worker'),
  createWorker: jest.fn()
}));

const UNO = { usbVendorId: 0x2341, usbProductId: 0x0043 };
const UNO_KEY = 's:2341:0043:0';
const UNO_NAME = 'tty-2341-0043';
const PROBE_NAME = 'usb-0d28-0204';
const STM32: IProfile = {
  id: 'stm32-bootloader',
  label: 'STM32 bootloader',
  baudRate: 115200,
  dataBits: 8,
  parity: 'even',
  stopBits: 1,
  onOpen: 'none'
};
const PROBE_REQUEST: IDeviceRequest = {
  id: 'request-1',
  kind: 'usb',
  vendorId: 0x0d28,
  productId: 0x0204,
  reason: 'flash the board',
  program: 'pyocd'
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
  profile: 'monitor',
  overrides: {},
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
  /** The body of every profile change the page sent to the server, in order. */
  changes: IProfileChange[];
  /** How the server answers a profile change; it accepts unless a test says otherwise. */
  answer: (change: IProfileChange) => Response;
  fetch: jest.Mock;
  model: DeviceBridgeModel;
  panel: DeviceBridgePanel;
  handlers: {
    connectSerial: jest.Mock;
    connectUsb: jest.Mock;
    grantRequest: jest.Mock;
    openTerminal: jest.Mock;
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

function setInterface(name: 'serial' | 'usb', value?: object): void {
  delete (navigator as unknown as Record<string, unknown>)[name];
  if (value) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

/** A lab page with the panel in the document, after the server answered. */
async function lab(options: ILabOptions = {}): Promise<ILab> {
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
  const changes: IProfileChange[] = [];
  // The lab always calls fetch with a Request object.
  const fetch = jest.fn(async (request: RequestInfo) => {
    const change = JSON.parse(
      await (request as Request).text()
    ) as IProfileChange;
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
    openTerminal: jest.fn()
  };
  const panel = new DeviceBridgePanel({ model, ...handlers });
  Widget.attach(panel, document.body);
  const all: ILab = {
    server,
    serial,
    usb,
    changes,
    answer: () => new Response('{}', { status: 200 }),
    fetch,
    model,
    panel,
    handlers
  };
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
  name: keyof IProfileChange
): HTMLInputElement | HTMLSelectElement =>
  one<HTMLInputElement>(root, `[data-profile-field="${name}"]`);

/** Set a field of the profile editor as the user does: the value, then the change event. */
function choose(root: ParentNode, name: keyof IProfileChange, value: string) {
  const node = control(root, name);
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Make the simulated server act on `PUT serial/<name>/profile` as the real one does:
 * a profile id replaces the overrides, a field adds one, and the table is sent.
 */
function serveProfiles(all: ILab): void {
  all.answer = change => {
    const record = all.server.table.serial[0];
    const { profile, ...fields } = change;
    if (profile) {
      record.profile = profile;
      record.overrides = {};
    }
    Object.assign(record.overrides, fields);
    const { baudRate, dataBits, parity, stopBits } = {
      ...all.server.profiles.find(known => known.id === record.profile)!,
      ...record.overrides
    };
    record.settings = { baudRate, dataBits, parity, stopBits };
    all.server.push();
    return new Response(JSON.stringify(record), { status: 200 });
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  emit.mockReset();
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
      expect(value).not.toMatch(named);
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
      expect(value).toMatch(/var\(--jp-|^none$/);
    }
    expect(css).toContain('.jp-DeviceBridgePanel ');
    expect(css).toContain('.jp-DeviceBridgeStatus ');
  });
});

describe('DeviceBridgePanel: the device rows', () => {
  it('ACC-PANEL-64 a serial row shows kind, name, state, holding program, baud rate and profile; a USB row shows kind, name, state and product', async () => {
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
    expect(text(serialRow, 'profile')).toBe('monitor');
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
    expect(usbRow.querySelector('[data-profile-field]')).toBeNull();

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
    const empty = one(all.panel.node, '.jp-DeviceBridgePanel-empty');
    const count = (): string | null =>
      text(one(all.panel.node, '[data-section="devices"]'), 'count');

    expect(rows()).toEqual([]);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toMatch(/^No device yet\./);
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

    expect(text(serialRow, 'rx')).toBe('0');
    expect(text(serialRow, 'tx')).toBe('0');

    port.receive([1, 2, 3]);
    await tick(1000);
    expect(text(serialRow, 'rx')).toBe('3');
    expect(text(serialRow, 'tx')).toBe('0');

    // The port echoes: two bytes written to it come back.
    all.server.sendData(1, [9, 9]);
    await tick(1000);
    expect(text(serialRow, 'rx')).toBe('5');
    expect(text(serialRow, 'tx')).toBe('2');
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

  it('ACC-PROF-23 an update of the device table keeps the row element, so an open profile editor stays open', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const serialRow = row(all, UNO_NAME);
    const editor = one<HTMLDetailsElement>(serialRow, 'details');
    editor.open = true;

    port.receive([1]);
    await tick(1000);

    expect(text(serialRow, 'rx')).toBe('1');
    expect(row(all, UNO_NAME)).toBe(serialRow);
    expect(one<HTMLDetailsElement>(serialRow, 'details')).toBe(editor);
    expect(editor.open).toBe(true);
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

describe('DeviceBridgePanel: the profile editor of a serial row', () => {
  /** A lab with one attached port, two profiles and a server that takes profile changes. */
  async function labWithProfiles(): Promise<ILab> {
    const all = await lab({
      ports: [new SimSerialPort(UNO)],
      prepare: server => {
        server.profiles.push(STM32);
      }
    });
    serveProfiles(all);
    return all;
  }

  it('ACC-PROF-23 the editor shows the profile of the port with its settings and the action on open', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);
    const options = (name: keyof IProfileChange): string[] =>
      Array.from(
        (control(serialRow, name) as HTMLSelectElement).options,
        option => option.value
      );

    expect(control(serialRow, 'profile').value).toBe('monitor');
    expect(control(serialRow, 'baudRate').value).toBe('115200');
    expect(control(serialRow, 'dataBits').value).toBe('8');
    expect(control(serialRow, 'parity').value).toBe('none');
    expect(control(serialRow, 'stopBits').value).toBe('1');
    expect(control(serialRow, 'onOpen').value).toBe('none');
    expect(options('profile')).toEqual(['monitor', 'stm32-bootloader']);
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
  });

  it('ACC-PROF-123 each choice of a default setting in the settings schema has the value and the label that the profile editor shows for it', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);
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
    /** The value and the label of every option of a select of the editor. */
    const offered = (name: keyof IProfileChange): string[][] =>
      Array.from(
        (control(serialRow, name) as HTMLSelectElement).options,
        option => [option.value, option.textContent ?? '']
      );

    expect(choices('defaultParity')).toEqual(offered('parity'));
    expect(choices('defaultOnOpen')).toEqual(offered('onOpen'));
    expect(choices('defaultDataBits')).toEqual(offered('dataBits'));
    expect(choices('defaultStopBits')).toEqual(offered('stopBits'));
    // The titles are words for a person, not the raw values.
    expect(choices('defaultOnOpen')).toContainEqual(['pulse-dtr', 'Pulse DTR']);
    expect(choices('defaultParity')).toContainEqual(['none', 'None']);
  });

  it('ACC-PROF-23 the baud rate field is a text field with the input mode numeric', async () => {
    const all = await labWithProfiles();

    const baud = control(row(all, UNO_NAME), 'baudRate');

    // DEF-PANEL-6: the arrow keys and the mouse wheel change a number field by 1.
    expect(baud.type).toBe('text');
    expect(baud.getAttribute('inputmode')).toBe('numeric');
  });

  it('ACC-PROF-23 choosing the profile stm32-bootloader sends it to the server, and the row and the editor show even parity', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);

    choose(serialRow, 'profile', 'stm32-bootloader');
    await tick();

    const [request] = all.fetch.mock.calls[0] as [Request];
    expect(request.method).toBe('PUT');
    expect(request.url.split('?')[0]).toBe(
      `http://lab.test/jupyterlab-device-bridge-extension/serial/${UNO_NAME}/profile`
    );
    expect(all.changes).toEqual([{ profile: 'stm32-bootloader' }]);
    expect(text(serialRow, 'profile')).toBe('stm32-bootloader');
    expect(control(serialRow, 'parity').value).toBe('even');
    expect(emit).not.toHaveBeenCalled();
  });

  it('ACC-PROF-23 parity, data bits, stop bits, baud rate and the action on open are each sent as one field, numbers as numbers', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);

    choose(serialRow, 'parity', 'odd');
    choose(serialRow, 'dataBits', '7');
    choose(serialRow, 'stopBits', '2');
    choose(serialRow, 'baudRate', '9600');
    choose(serialRow, 'onOpen', 'esp-bootloader');
    await tick();

    expect(all.changes).toEqual([
      { parity: 'odd' },
      { dataBits: 7 },
      { stopBits: 2 },
      { baudRate: 9600 },
      { onOpen: 'esp-bootloader' }
    ]);
    expect(all.server.table.serial[0].overrides).toEqual({
      parity: 'odd',
      dataBits: 7,
      stopBits: 2,
      baudRate: 9600,
      onOpen: 'esp-bootloader'
    });
    expect(control(serialRow, 'onOpen').value).toBe('esp-bootloader');
    expect(text(serialRow, 'baud')).toBe('9600');

    // A profile id replaces the single fields: the editor shows the profile again.
    choose(serialRow, 'profile', 'stm32-bootloader');
    await tick();
    expect(control(serialRow, 'parity').value).toBe('even');
    expect(control(serialRow, 'dataBits').value).toBe('8');
    expect(control(serialRow, 'stopBits').value).toBe('1');
    expect(control(serialRow, 'baudRate').value).toBe('115200');
    expect(control(serialRow, 'onOpen').value).toBe('none');
  });

  it('ACC-PROF-23 the editor shows the baud rate and the action on open of the profile with its overrides, not the baud rate a tool set on the port', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);
    Object.assign(all.server.table.serial[0], {
      profile: 'stm32-bootloader',
      overrides: { onOpen: 'pulse-dtr' },
      // A tool holds the virtual device and has set 57600 baud on it.
      holder: { pid: 7, name: 'stm32flash' },
      settings: { baudRate: 57600, dataBits: 8, parity: 'even', stopBits: 1 }
    });
    all.server.push();
    await tick();

    expect(text(serialRow, 'baud')).toBe('57600');
    expect(control(serialRow, 'profile').value).toBe('stm32-bootloader');
    expect(control(serialRow, 'baudRate').value).toBe('115200');
    expect(control(serialRow, 'parity').value).toBe('even');
    expect(control(serialRow, 'onOpen').value).toBe('pulse-dtr');

    all.server.table.serial[0].overrides = {};
    all.server.push();
    await tick();
    expect(control(serialRow, 'onOpen').value).toBe('none');
  });

  it('ACC-PROF-23 a change the server refuses raises a notification with the message of the server and the field shows the profile again', async () => {
    const all = await labWithProfiles();
    const serialRow = row(all, UNO_NAME);
    const refusal = {
      error: {
        code: 400,
        message: 'baudRate: 0 is not a whole number from 1 to 4294967295'
      }
    };
    all.answer = () => new Response(JSON.stringify(refusal), { status: 400 });
    const baud = control(serialRow, 'baudRate');

    // The field keeps the focus, as after the Enter key.
    baud.focus();
    choose(serialRow, 'baudRate', '');
    await tick();

    expect(all.changes).toEqual([{ baudRate: 0 }]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      `The profile of ${UNO_NAME} was not changed: baudRate: 0 is not a whole number from 1 to 4294967295`,
      'error',
      { autoClose: false }
    );
    expect(baud.value).toBe('115200');
  });

  it('ACC-PROF-23 an update of the device table does not replace a baud rate the user is typing', async () => {
    const port = new SimSerialPort(UNO);
    const all = await lab({ ports: [port] });
    const serialRow = row(all, UNO_NAME);
    const baud = control(serialRow, 'baudRate');

    baud.focus();
    baud.value = '96';
    port.receive([1]);
    await tick(1000);
    expect(text(serialRow, 'rx')).toBe('1');
    expect(baud.value).toBe('96');

    // After the user left the field without a change, the next update shows the profile.
    baud.blur();
    port.receive([2]);
    await tick(1000);
    expect(baud.value).toBe('115200');
  });
});

describe('DeviceBridgePanel: buttons that go to the plugin', () => {
  it('ACC-SERIAL-1 the add serial port button calls the connect handler of the plugin once per click', async () => {
    const all = await lab();

    action(all.panel.node, 'connect-serial').click();

    expect(all.handlers.connectSerial).toHaveBeenCalledTimes(1);
    expect(all.handlers.connectUsb).not.toHaveBeenCalled();
    expect(all.serial.dialogs).toEqual([]);
  });

  it('ACC-USB-45 the add USB device button calls the connect handler of the plugin once per click', async () => {
    const all = await lab();

    action(all.panel.node, 'connect-usb').click();

    expect(all.handlers.connectUsb).toHaveBeenCalledTimes(1);
    expect(all.handlers.connectSerial).not.toHaveBeenCalled();
    expect(all.usb.dialogs).toEqual([]);
  });

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

describe('DeviceBridgePanel: round trip and absent interfaces', () => {
  it('ACC-SERIAL-15 the round trip field shows the measured ms, and not connected while the WebSocket is closed', async () => {
    const all = await lab({
      prepare: server => {
        server.pongDelay = 12;
      }
    });
    const roundTrip = field(all.panel.node, 'round-trip');

    expect(roundTrip.textContent).toBe('not connected');
    await tick(12);
    expect(roundTrip.textContent).toBe('12.0 ms');

    all.server.accepting = false;
    all.server.drop();
    expect(roundTrip.textContent).toBe('not connected');
  });

  it('ACC-PANEL-70 without the device interfaces the panel names HTTPS and localhost and both add buttons are disabled', async () => {
    const all = await lab({ interfaces: [] });
    const absent = field(all.panel.node, 'absent');
    const addSerial = action(all.panel.node, 'connect-serial');
    const addUsb = action(all.panel.node, 'connect-usb');

    expect(absent.hidden).toBe(false);
    expect(absent.textContent).toBe(
      'The browser gives this page no access to serial ports and USB devices. Open the lab over HTTPS or at localhost, in Chrome or Edge.'
    );
    expect(addSerial.disabled).toBe(true);
    expect(addUsb.disabled).toBe(true);

    addSerial.click();
    addUsb.click();
    expect(all.handlers.connectSerial).not.toHaveBeenCalled();
    expect(all.handlers.connectUsb).not.toHaveBeenCalled();
  });

  it('ACC-PANEL-70 with both device interfaces the panel shows no such message and both add buttons work', async () => {
    const all = await lab();

    expect(field(all.panel.node, 'absent').hidden).toBe(true);
    expect(action(all.panel.node, 'connect-serial').disabled).toBe(false);
    expect(action(all.panel.node, 'connect-usb').disabled).toBe(false);
  });

  it('ACC-PANEL-70 a browser with one device interface gets the message for the absent one and the button of the other', async () => {
    const all = await lab({ interfaces: ['serial'] });
    const absent = field(all.panel.node, 'absent');

    expect(absent.hidden).toBe(false);
    expect(absent.textContent).toMatch(
      /^The browser gives this page no access to USB devices\. /
    );
    expect(action(all.panel.node, 'connect-serial').disabled).toBe(false);
    expect(action(all.panel.node, 'connect-usb').disabled).toBe(true);
  });
});
