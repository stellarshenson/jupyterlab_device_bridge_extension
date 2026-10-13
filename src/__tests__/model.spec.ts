/**
 * The model against the real worker function, simulated devices and a simulated server.
 *
 * `createWorker` is replaced: it runs `workerMain` on a simulated scope and returns
 * the page end of that scope. The page and the worker share one simulated
 * `navigator.serial` and `navigator.usb`, as they share the grants in a browser.
 */

import { ServerConnection } from '@jupyterlab/services';

import { DeviceBridgeModel, GrantError } from '../model';
import type {
  IDeviceRequest,
  IRunRecord,
  ISerialDefaults,
  ISerialRecord,
  IUsbRecord,
  PageToWorker
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

jest.mock('../worker', () => ({
  ...jest.requireActual('../worker'),
  createWorker: jest.fn()
}));

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
const NO_GESTURE = new DOMException(
  'Must be handling a user gesture to show a permission request.',
  'SecurityError'
);
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
  command: `avrdude -c arduino -p atmega328p -P /run/devices/${UNO_NAME}`,
  device: UNO_NAME
};
/** Default serial settings of a lab; each value differs from profile monitor. */
const DEFAULTS: ISerialDefaults = {
  baudRate: 9600,
  dataBits: 7,
  parity: 'even',
  stopBits: 2,
  onOpen: 'pulse-dtr'
};

interface ILab {
  server: SimServer;
  serial: SimSerial;
  usb: SimUsb;
  scope: SimScope;
  fetch: jest.Mock;
  model: DeviceBridgeModel;
  /** Every message the model posted to the worker, in order. */
  posts: PageToWorker[];
}

interface ILabOptions {
  ports?: SimSerialPort[];
  devices?: SimUsbDevice[];
  token?: string;
  /** False: the browser has neither device interface, as on plain http. */
  interfaces?: boolean;
  /** Runs before the model starts the worker. */
  prepare?: (server: SimServer) => void;
  /** The default serial settings the model is built with; none when omitted. */
  serialDefaults?: ISerialDefaults;
}

/** Let every promise settle and advance the fake time by `ms`. */
const tick = (ms = 0): Promise<void> => jest.advanceTimersByTimeAsync(ms);

function setInterface(name: 'serial' | 'usb', value?: object): void {
  delete (navigator as unknown as Record<string, unknown>)[name];
  if (value) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

/** A lab page: a model, its worker, the browser's devices and the server. */
function lab(options: ILabOptions = {}): ILab {
  const interfaces = options.interfaces !== false;
  const server = new SimServer();
  const serial = new SimSerial(...(options.ports || []));
  const usb = new SimUsb(...(options.devices || []));
  const scope = interfaces
    ? new SimScope(server, serial, usb)
    : new SimScope(server);
  setInterface('serial', interfaces ? serial : undefined);
  setInterface('usb', interfaces ? usb : undefined);
  (createWorker as jest.Mock).mockImplementation(() => {
    workerMain(scope);
    return scope.page;
  });
  if (options.prepare) {
    options.prepare(server);
  }
  const posts: PageToWorker[] = [];
  const deliver = scope.post.bind(scope);
  scope.post = message => {
    posts.push(message);
    deliver(message);
  };
  const fetch = jest.fn(async () => new Response('{}', { status: 200 }));
  const model = new DeviceBridgeModel(
    ServerConnection.makeSettings({
      baseUrl: 'http://lab.test/',
      wsUrl: 'ws://lab.test/',
      token: options.token || '',
      fetch
    }),
    options.serialDefaults
  );
  return { server, serial, usb, scope, fetch, model, posts };
}

/** A lab whose server has answered and whose granted devices are attached. */
async function connectedLab(options: ILabOptions = {}): Promise<ILab> {
  const all = lab(options);
  await tick();
  return all;
}

/** Collect what a signal of the model emits. */
function emitted<T>(signal: {
  connect(slot: (sender: unknown, value: T) => void): unknown;
}): T[] {
  const values: T[] = [];
  signal.connect((_, value) => values.push(value));
  return values;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  setInterface('serial');
  setInterface('usb');
});

describe('DeviceBridgeModel: what it reports', () => {
  it('ACC-SERIAL-14 the model starts the worker and gives it the WebSocket URL of the lab with the token', async () => {
    const { server } = await connectedLab({ token: 'secret token' });

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(server.sockets.map(socket => socket.url)).toEqual([
      'ws://lab.test/jupyterlab-device-bridge-extension/ws?token=secret%20token'
    ]);
  });

  it('ACC-SERIAL-14 the WebSocket URL has no token when the server settings have none', async () => {
    const { server } = await connectedLab();

    expect(server.sockets.map(socket => socket.url)).toEqual([
      'ws://lab.test/jupyterlab-device-bridge-extension/ws'
    ]);
  });

  it('ACC-PANEL-154 interfaces says which device interfaces the browser has', async () => {
    expect((await connectedLab()).model.interfaces).toEqual({
      serial: true,
      usb: true
    });

    const plain = await connectedLab({ interfaces: false });
    expect(plain.model.interfaces).toEqual({ serial: false, usb: false });
    // The device table still arrives: the tab shows what other tabs hold.
    expect(plain.model.tabId).toBe('tab-1');
  });

  it('ACC-PANEL-71 the tab id, the profiles and the device table arrive from the server, each with its signal', async () => {
    const { model } = lab({ ports: [new SimSerialPort(UNO)] });
    const tabIds = emitted(model.tabIdChanged);
    const tables = emitted(model.devicesChanged);

    expect(model.tabId).toBeNull();
    expect(model.devices).toEqual({ serial: [], usb: [] });
    await tick();

    expect(model.tabId).toBe('tab-1');
    expect(tabIds).toEqual(['tab-1']);
    expect(model.profiles.map(profile => profile.id)).toEqual(['monitor']);
    expect(model.devices.serial).toEqual([
      expect.objectContaining({
        name: UNO_NAME,
        state: 'attached',
        tab: 'tab-1',
        portState: 'open'
      })
    ]);
    expect(tables[tables.length - 1]).toBe(model.devices);
  });

  it('ACC-SERIAL-15 the round trip in ms is reported with its signal', async () => {
    const { model } = lab({
      prepare: server => {
        server.pongDelay = 12;
      }
    });
    const roundTrips = emitted(model.roundTripChanged);

    expect(model.roundTrip).toBeNull();
    await tick(12);

    expect(model.roundTrip).toBe(12);
    expect(roundTrips).toEqual([12]);
  });

  it('ACC-USB-47 the pending device requests are reported with their signal', async () => {
    const { model, server } = await connectedLab();
    const requests = emitted(model.requestsChanged);

    server.pending.push(PROBE_REQUEST);
    server.push();
    await tick();

    expect(model.requests).toEqual([PROBE_REQUEST]);
    expect(requests).toEqual([[PROBE_REQUEST]]);
  });

  it('ACC-PANEL-131 the runs arrive from the server after the welcome and on every change, each time with their signal', async () => {
    const { model, server } = lab({
      prepare: prepared => {
        prepared.running.push(SHELL_RUN);
      }
    });
    const runs = emitted(model.runsChanged);

    // Before the server answered the model has no run, and reading it does not fail.
    expect(model.runs).toEqual([]);
    await tick();

    expect(model.runs).toEqual([SHELL_RUN]);
    expect(runs).toEqual([[SHELL_RUN]]);

    server.running.push(UPLOAD_RUN);
    server.pushRuns();
    await tick();
    expect(model.runs).toEqual([SHELL_RUN, UPLOAD_RUN]);

    server.running.length = 0;
    server.pushRuns();
    await tick();
    expect(model.runs).toEqual([]);
    expect(runs).toEqual([[SHELL_RUN], [SHELL_RUN, UPLOAD_RUN], []]);
  });

  it('ACC-PANEL-131 while the WebSocket is closed the model reports no run, with the signal, and the runs come again when the server answers', async () => {
    const { model, server } = await connectedLab({
      prepare: prepared => {
        prepared.running.push(SHELL_RUN);
      }
    });
    const runs = emitted(model.runsChanged);
    expect(model.runs).toEqual([SHELL_RUN]);

    server.accepting = false;
    server.drop();

    expect(model.runs).toEqual([]);
    expect(runs).toEqual([[]]);

    // The worker connects again after 0.5 s, and the server lists its runs.
    server.accepting = true;
    await tick(500);

    expect(model.runs).toEqual([SHELL_RUN]);
    expect(runs).toEqual([[], [SHELL_RUN]]);
  });

  it('ACC-PANEL-138 the model passes each activity message of the worker on with its signal, once per message and with the devices of that message', async () => {
    const port = new SimSerialPort(UNO);
    port.echo = false;
    const { model, server } = await connectedLab({ ports: [port] });
    const activity = emitted(model.activity);

    // An open port without traffic: the worker posts nothing.
    await tick(1000);
    expect(activity).toEqual([]);

    port.receive([1, 2, 3]);
    await tick(50);
    server.sendData(1, [9]);
    await tick(50);

    expect(activity).toEqual([
      [{ name: UNO_NAME, rx: true, tx: false }],
      [{ name: UNO_NAME, rx: false, tx: true }]
    ]);
  });

  it('ACC-SERIAL-20 while the WebSocket is closed the model reports no device, no request and no round trip', async () => {
    const { model, server } = await connectedLab({
      ports: [new SimSerialPort(UNO)]
    });
    server.pending.push(PROBE_REQUEST);
    server.push();
    await tick();
    const tables = emitted(model.devicesChanged);
    const requests = emitted(model.requestsChanged);
    const roundTrips = emitted(model.roundTripChanged);

    server.accepting = false;
    server.drop();

    expect(model.devices).toEqual({ serial: [], usb: [] });
    expect(model.requests).toEqual([]);
    expect(model.roundTrip).toBeNull();
    expect(tables.length).toBeGreaterThan(0);
    expect(requests).toEqual([[]]);
    expect(roundTrips).toEqual([null]);
    // The id of the tab is its own and stays.
    expect(model.tabId).toBe('tab-1');
  });

  it('ACC-PANEL-66 dispose stops the worker and the signals', async () => {
    const { model, server, scope } = await connectedLab();
    const tables = emitted(model.devicesChanged);

    model.dispose();
    model.dispose();
    server.push();
    await tick();
    // A message that was on its way when the worker stopped still reaches the page.
    scope.page.onmessage?.({ data: { type: 'devices', serial: [], usb: [] } });

    expect(scope.terminated).toBe(true);
    expect(model.isDisposed).toBe(true);
    expect(tables).toEqual([]);
  });
});

describe('DeviceBridgeModel: default serial settings', () => {
  const WS_URL = 'ws://lab.test/jupyterlab-device-bridge-extension/ws';

  it('ACC-PROF-118 the model gives the worker the default serial settings before start, so the claim of a port granted earlier carries them', async () => {
    const { posts, server } = await connectedLab({
      ports: [new SimSerialPort(UNO)],
      serialDefaults: DEFAULTS
    });

    expect(posts).toEqual([
      { type: 'defaults', serial: DEFAULTS },
      { type: 'start', url: WS_URL }
    ]);
    expect(server.sent('claim')).toEqual([
      {
        type: 'claim',
        kind: 'serial',
        key: UNO_KEY,
        info: UNO,
        defaults: DEFAULTS
      }
    ]);
  });

  it('ACC-PROF-118 a model built without default serial settings sends the worker none, and the claim has no field defaults', async () => {
    const { posts, server } = await connectedLab({
      ports: [new SimSerialPort(UNO)]
    });

    expect(posts).toEqual([{ type: 'start', url: WS_URL }]);
    expect(server.sent('claim')).toHaveLength(1);
    expect(server.sent('claim')[0]).not.toHaveProperty('defaults');
  });

  it('ACC-PROF-119 setSerialDefaults gives the worker the changed settings, and a port added after it is claimed with them', async () => {
    const { model, posts, serial, server } = await connectedLab({
      ports: [new SimSerialPort(UNO)],
      serialDefaults: DEFAULTS
    });
    const changed: ISerialDefaults = { ...DEFAULTS, baudRate: 57600 };

    model.setSerialDefaults(changed);
    expect(posts[posts.length - 1]).toEqual({
      type: 'defaults',
      serial: changed
    });
    serial.dialog = new SimSerialPort(UNO);
    await model.connectSerial();
    await tick();

    expect(
      server.sent('claim').map(claim => [claim.key, claim.defaults])
    ).toEqual([
      [UNO_KEY, DEFAULTS],
      ['s:2341:0043:1', changed]
    ]);
  });
});

describe('DeviceBridgeModel: grant dialogs', () => {
  it('ACC-SERIAL-1 connectSerial opens the port dialog in the page, and the worker attaches the port the user picks', async () => {
    const { model, serial } = await connectedLab();
    const port = new SimSerialPort(UNO);
    serial.dialog = port;

    await model.connectSerial();
    await tick();

    expect(serial.dialogs).toEqual([null]);
    expect(port.opens).toHaveLength(1);
    expect(model.devices.serial).toEqual([
      expect.objectContaining({
        name: UNO_NAME,
        state: 'attached',
        tab: model.tabId
      })
    ]);
    expect(model.hasGrant(UNO_NAME)).toBe(true);
  });

  it('ACC-USB-45 connectUsb opens the device dialog with the given filters, and the worker attaches the device the user picks', async () => {
    const { model, usb } = await connectedLab();
    usb.dialog = new SimUsbDevice();

    await model.connectUsb([{ vendorId: 0x0d28 }]);
    await model.connectUsb();
    await tick();

    expect(usb.dialogs).toEqual([
      { filters: [{ vendorId: 0x0d28 }] },
      { filters: [] }
    ]);
    expect(model.devices.usb).toEqual([
      expect.objectContaining({
        name: PROBE_NAME,
        state: 'attached',
        tab: model.tabId
      })
    ]);
  });

  it('ACC-PANEL-72 a dialog the browser refuses outside a user gesture and a dialog the user cancels reject with different reasons', async () => {
    const { model, serial, usb, server } = await connectedLab();

    serial.dialog = NO_GESTURE;
    const refused = await model.connectSerial().catch(error => error);
    expect(refused).toBeInstanceOf(GrantError);
    expect(refused).toMatchObject({
      reason: 'gesture',
      message: NO_GESTURE.message,
      browser: { name: 'SecurityError', message: NO_GESTURE.message }
    });

    // The default of the simulated dialog: the user closes it without a device.
    const cancelled = await model.connectUsb().catch(error => error);
    expect(cancelled).toBeInstanceOf(GrantError);
    expect(cancelled).toMatchObject({
      reason: 'cancelled',
      browser: { name: 'NotFoundError', message: 'No device selected.' }
    });

    usb.dialog = new DOMException('Access denied.', 'NetworkError');
    await expect(model.connectUsb()).rejects.toMatchObject({
      reason: 'failed',
      browser: { name: 'NetworkError', message: 'Access denied.' }
    });

    await tick();
    expect(server.sent('claim')).toEqual([]);
  });

  it('ACC-PANEL-154 without the browser interface a connect call rejects with reason unsupported and a message that names HTTPS and localhost', async () => {
    const { model } = await connectedLab({ interfaces: false });

    for (const call of [model.connectSerial(), model.connectUsb()]) {
      const error = await call.catch(reason => reason);
      expect(error).toBeInstanceOf(GrantError);
      expect(error.reason).toBe('unsupported');
      expect(error.message).toMatch(/HTTPS.*localhost/);
    }
  });
});

describe('DeviceBridgeModel: attach, detach, forget, profile', () => {
  it('ACC-SERIAL-18 detach closes the port and keeps the grant; attach attaches the device again under its name', async () => {
    const port = new SimSerialPort(UNO);
    const { model, server } = await connectedLab({ ports: [port] });

    model.detach(UNO_NAME);
    await tick();
    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'detach' }
    ]);
    expect(port.isOpen).toBe(false);
    expect(model.devices.serial[0]).toMatchObject({
      name: UNO_NAME,
      state: 'detached',
      tab: null
    });
    expect(model.hasGrant(UNO_NAME)).toBe(true);

    // A second detach finds no attached grant and releases nothing.
    model.detach(UNO_NAME);
    await tick();
    expect(server.sent('release')).toHaveLength(1);

    model.attach(UNO_NAME);
    await tick();
    expect(port.isOpen).toBe(true);
    expect(model.devices.serial[0]).toMatchObject({
      name: UNO_NAME,
      state: 'attached',
      tab: 'tab-1'
    });
  });

  it('ACC-SERIAL-19 forget revokes the grant and removes the device from the table', async () => {
    const port = new SimSerialPort(UNO);
    const { model, server } = await connectedLab({ ports: [port] });

    model.forget(UNO_NAME);
    await tick();

    expect(port.forgotten).toBe(true);
    expect(port.isOpen).toBe(false);
    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'forget' }
    ]);
    expect(model.devices.serial).toEqual([]);
    expect(model.hasGrant(UNO_NAME)).toBe(false);
  });

  it('ACC-PANEL-71 a device another tab holds can be attached from this tab after that tab gave it up', async () => {
    const port = new SimSerialPort(UNO);
    const held: ISerialRecord = {
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
    // Devices this tab has no grant for: each differs from the port in one id.
    const otherVendor = { ...held, name: 'tty-1a86-0043', vendorId: 0x1a86 };
    const otherProduct = { ...held, name: 'tty-2341-0001', productId: 0x0001 };
    const { model, server } = await connectedLab({
      ports: [port],
      prepare: simulated => {
        simulated.table.serial.push(held, otherVendor, otherProduct);
        simulated.heldBy.set(UNO_KEY, 'tab-2');
      }
    });

    expect(port.calls).toEqual([]);
    expect(model.devices.serial[0]).toMatchObject({ tab: 'tab-2' });
    // The refusal of the server carried no name: the grant is found by its ids.
    expect(model.hasGrant(UNO_NAME)).toBe(true);
    expect(model.hasGrant(otherVendor.name)).toBe(false);
    expect(model.hasGrant(otherProduct.name)).toBe(false);
    expect(model.hasGrant('tty-0000-0000')).toBe(false);

    server.heldBy.clear();
    Object.assign(held, { state: 'detached', tab: null });
    server.push();
    await tick();
    model.attach(UNO_NAME);
    await tick();

    expect(server.sent('claim')).toHaveLength(2);
    expect(port.isOpen).toBe(true);
    expect(model.devices.serial[0]).toMatchObject({
      name: UNO_NAME,
      state: 'attached',
      tab: 'tab-1'
    });
  });

  it('ACC-SERIAL-19 forget of a second device with the ids of a port this tab holds leaves the grant of that port', async () => {
    const port = new SimSerialPort(UNO);
    const { model, server } = await connectedLab({ ports: [port] });
    // A second board of the same kind that another tab attached and gave up.
    const twin: ISerialRecord = {
      ...server.table.serial[0],
      name: `${UNO_NAME}-2`,
      state: 'detached',
      tab: null
    };
    server.table.serial.push(twin);
    server.push();
    await tick();

    expect(model.hasGrant(UNO_NAME)).toBe(true);
    expect(model.hasGrant(twin.name)).toBe(false);

    model.forget(twin.name);
    await tick();

    expect(port.forgotten).toBe(false);
    expect(port.isOpen).toBe(true);
    expect(server.sent('release')).toEqual([
      { type: 'release', name: twin.name, reason: 'forget' }
    ]);
    expect(model.devices.serial.map(record => record.name)).toEqual([UNO_NAME]);
  });

  it('ACC-PANEL-71 a grant without a name belongs to a USB device only with the same ids, the same serial number and the same kind', async () => {
    const held: IUsbRecord = {
      name: PROBE_NAME,
      state: 'attached',
      tab: 'tab-2',
      vendorId: 0x0d28,
      productId: 0x0204,
      productName: 'Simulated Probe',
      manufacturerName: 'Simulation',
      serialNumber: 'SIM0001',
      opened: false,
      holder: null,
      rx: 0,
      tx: 0,
      error: null
    };
    const otherSerialNumber = {
      ...held,
      name: `${PROBE_NAME}-2`,
      serialNumber: 'SIM0002'
    };
    // A probe without a serial number, and the serial port of that same probe.
    // This tab has a grant for its USB interface only.
    const plain = {
      ...held,
      name: 'usb-0d28-0205',
      productId: 0x0205,
      serialNumber: null
    };
    const serialTwin: ISerialRecord = {
      name: 'tty-0d28-0205',
      path: '/tmp/jupyterlab-device-1000/tty-0d28-0205',
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
      vendorId: 0x0d28,
      productId: 0x0205,
      error: null
    };
    const { model } = await connectedLab({
      devices: [
        new SimUsbDevice(),
        new SimUsbDevice({ productId: 0x0205, serialNumber: null })
      ],
      prepare: simulated => {
        simulated.table.usb.push(held, otherSerialNumber, plain);
        simulated.table.serial.push(serialTwin);
        simulated.heldBy.set('u:0d28:0204:SIM0001', 'tab-2');
        simulated.heldBy.set('u:0d28:0205:#0', 'tab-2');
      }
    });

    expect(model.hasGrant(PROBE_NAME)).toBe(true);
    expect(model.hasGrant(otherSerialNumber.name)).toBe(false);
    expect(model.hasGrant(plain.name)).toBe(true);
    expect(model.hasGrant(serialTwin.name)).toBe(false);
  });

  it('ACC-PROF-23 setProfile sends the change with PUT to serial/<name>/profile, and a refusal rejects with the message of the server', async () => {
    const { model, fetch } = await connectedLab();
    const change = { profile: 'stm32-bootloader', parity: 'even' } as const;

    await model.setProfile(UNO_NAME, change);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [request] = fetch.mock.calls[0] as unknown as [Request];
    expect(request.method).toBe('PUT');
    // The lab adds a query to a request that must not come from a cache.
    expect(request.url.split('?')[0]).toBe(
      `http://lab.test/jupyterlab-device-bridge-extension/serial/${UNO_NAME}/profile`
    );
    expect(JSON.parse(await request.text())).toEqual(change);

    const refusal = { error: { code: 400, message: 'Unknown profile nope' } };
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(refusal), { status: 400 })
    );
    await expect(
      model.setProfile(UNO_NAME, { profile: 'nope' })
    ).rejects.toThrow('Unknown profile nope');
  });
});

describe('DeviceBridgeModel: runs', () => {
  it('ACC-PANEL-133 stopRun sends DELETE to runs/<pid> with no body and takes the answer 204, which has none', async () => {
    const { model, fetch } = await connectedLab();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(model.stopRun(4242)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [request] = fetch.mock.calls[0] as unknown as [Request];
    expect(request.method).toBe('DELETE');
    // The lab adds a query to a request that must not come from a cache.
    expect(request.url.split('?')[0]).toBe(
      'http://lab.test/jupyterlab-device-bridge-extension/runs/4242'
    );
    expect(await request.text()).toBe('');
  });

  it('ACC-PANEL-133 a stop that the server refuses rejects with the message of the server', async () => {
    const { model, fetch } = await connectedLab();
    const refusal = {
      error: { code: 'unknown-run', message: 'No run has the pid 4242' }
    };
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(refusal), { status: 404 })
    );

    await expect(model.stopRun(4242)).rejects.toThrow(
      'No run has the pid 4242'
    );
  });
});

describe('DeviceBridgeModel: device requests', () => {
  /** A lab whose server has one pending request. */
  async function labWithRequest(request: IDeviceRequest): Promise<ILab> {
    const all = await connectedLab();
    all.server.pending.push(request);
    all.server.push();
    await tick();
    return all;
  }

  it('ACC-USB-48 grantRequest opens the device dialog with the vendor and product id of the request, attaches the device and answers the request with its name', async () => {
    const { model, usb, server } = await labWithRequest(PROBE_REQUEST);
    usb.dialog = new SimUsbDevice();

    await model.grantRequest('request-1');
    await tick();

    expect(usb.dialogs).toEqual([
      { filters: [{ vendorId: 0x0d28, productId: 0x0204 }] }
    ]);
    expect(server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-1', ok: true, name: PROBE_NAME }
    ]);
    expect(model.devices.usb[0]).toMatchObject({
      name: PROBE_NAME,
      state: 'attached'
    });
    expect(model.requests).toEqual([]);
  });

  it('ACC-USB-48 grantRequest for a serial port opens the port dialog with the ids of the request', async () => {
    const { model, serial, server } = await labWithRequest({
      ...PROBE_REQUEST,
      kind: 'serial',
      vendorId: 0x2341,
      productId: 0x0043
    });
    serial.dialog = new SimSerialPort(UNO);

    await model.grantRequest('request-1');
    await tick();

    expect(serial.dialogs).toEqual([
      { filters: [{ usbVendorId: 0x2341, usbProductId: 0x0043 }] }
    ]);
    expect(server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-1', ok: true, name: UNO_NAME }
    ]);
  });

  it.each([
    ['serial', null],
    ['usb', { filters: [] }]
  ] as const)(
    'ACC-USB-48 a %s request without ids, also with ids sent as null, opens the dialog without a filter',
    async (kind, options) => {
      const noIds = { vendorId: null, productId: null } as unknown as object;
      const { model, serial, usb } = await labWithRequest({
        ...PROBE_REQUEST,
        ...noIds,
        kind
      });

      await model.grantRequest('request-1').catch(() => undefined);

      expect(kind === 'serial' ? serial.dialogs : usb.dialogs).toEqual([
        options
      ]);
    }
  );

  it('ACC-USB-49 a dialog the user cancels answers the request as denied with the reason of the browser', async () => {
    const { model, server } = await labWithRequest(PROBE_REQUEST);

    await expect(model.grantRequest('request-1')).rejects.toMatchObject({
      reason: 'cancelled'
    });
    await tick();

    expect(server.sent('request-result')).toEqual([
      {
        type: 'request-result',
        id: 'request-1',
        ok: false,
        error: { name: 'NotFoundError', message: 'No device selected.' }
      }
    ]);
    expect(model.requests).toEqual([]);
  });

  it('ACC-PANEL-72 a grant outside a user gesture rejects with reason gesture and leaves the request pending', async () => {
    const { model, usb, server } = await labWithRequest(PROBE_REQUEST);
    usb.dialog = NO_GESTURE;

    await expect(model.grantRequest('request-1')).rejects.toMatchObject({
      reason: 'gesture'
    });
    await tick();

    expect(server.sent('request-result')).toEqual([]);
    expect(model.requests).toEqual([PROBE_REQUEST]);
  });

  it('ACC-USB-50 grantRequest for a request that is not pending rejects and opens no dialog', async () => {
    const { model, usb, serial } = await connectedLab();

    await expect(model.grantRequest('request-9')).rejects.toThrow(
      'Device request request-9 is not pending'
    );

    expect(usb.dialogs).toEqual([]);
    expect(serial.dialogs).toEqual([]);
  });
});
