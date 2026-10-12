/**
 * The dedicated worker against simulated devices and a simulated server.
 *
 * `workerMain` runs directly on a simulated worker scope. Timers are fake, so a wait
 * inside the worker ends only when a test advances the time.
 */

import * as ts from 'typescript';

import type {
  IAckMessage,
  ISerialDefaults,
  ISerialSettings
} from '../protocol';
import { createWorker, workerMain } from '../worker';
import {
  BULK_ENDPOINT,
  CONTROL_ENDPOINT,
  INTERRUPT_ENDPOINT,
  SimScope,
  SimSerial,
  SimSerialPort,
  SimServer,
  SimUsb,
  SimUsbDevice,
  fromBase64,
  toBase64
} from './sim';

declare const __dirname: string;

const WS_URL = 'ws://lab.test/jupyterlab-device-bridge-extension/ws';
const UNO = { usbVendorId: 0x2341, usbProductId: 0x0043 };
const UNO_KEY = 's:2341:0043:0';
const UNO_NAME = 'tty-2341-0043';
const UNO_GRANT = {
  kind: 'serial',
  key: UNO_KEY,
  vendorId: 0x2341,
  productId: 0x0043
};
const PROBE_KEY = 'u:0d28:0204:SIM0001';
const PROBE_NAME = 'usb-0d28-0204';
const SETTINGS: ISerialSettings = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
};
const ALL_BYTES = Array.from({ length: 256 }, (_, value) => value);
/** Default serial settings of a lab; each value differs from profile monitor. */
const DEFAULTS: ISerialDefaults = {
  baudRate: 9600,
  dataBits: 7,
  parity: 'even',
  stopBits: 2,
  onOpen: 'pulse-dtr'
};

interface IRig {
  server: SimServer;
  serial: SimSerial;
  usb: SimUsb;
  scope: SimScope;
}

/** Let every promise settle and advance the fake time by `ms`. */
const tick = (ms = 0): Promise<void> => jest.advanceTimersByTimeAsync(ms);

/** A worker on a simulated scope; it waits for `start`. */
function rig(ports: SimSerialPort[] = [], devices: SimUsbDevice[] = []): IRig {
  const server = new SimServer();
  const serial = new SimSerial(...ports);
  const usb = new SimUsb(...devices);
  const scope = new SimScope(server, serial, usb);
  workerMain(scope);
  return { server, serial, usb, scope };
}

/** Send `start` and let the connection, the claims and the opens finish. */
async function connect({ scope }: IRig): Promise<void> {
  scope.post({ type: 'start', url: WS_URL });
  await tick();
}

/** A connected worker with one granted serial port, attached and open. */
async function withPort(): Promise<IRig & { port: SimSerialPort }> {
  const port = new SimSerialPort(UNO);
  const all = rig([port]);
  await connect(all);
  return { ...all, port };
}

/** A connected worker with one granted USB device, attached; open when asked. */
async function withDevice(
  open = false
): Promise<IRig & { device: SimUsbDevice }> {
  const device = new SimUsbDevice();
  const all = rig([], [device]);
  await connect(all);
  if (open) {
    all.server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    await tick();
  }
  return { ...all, device };
}

const okAck = (seq: number): IAckMessage => ({ type: 'ack', seq, ok: true });

const lastGrants = (scope: SimScope): unknown => {
  const all = scope.postedOf('grants');
  return all[all.length - 1].grants;
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('serial port: claim and open', () => {
  it('ACC-SERIAL-2 a granted port is claimed and opened on connect, with no message from the page but start', async () => {
    const { server, port } = await withPort();

    expect(server.sockets.map(socket => socket.url)).toEqual([WS_URL]);
    expect(server.received[0]).toEqual({
      type: 'hello',
      tabId: 'tab-1',
      serial: true,
      usb: true
    });
    expect(server.sent('claim')).toEqual([
      { type: 'claim', kind: 'serial', key: UNO_KEY, info: UNO }
    ]);
    expect(port.opens).toEqual([
      {
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        bufferSize: 65536,
        flowControl: 'none'
      }
    ]);
    expect(server.sent('serial-state')).toEqual([
      {
        type: 'serial-state',
        name: UNO_NAME,
        state: 'opening',
        settings: SETTINGS,
        signals: {}
      },
      {
        type: 'serial-state',
        name: UNO_NAME,
        state: 'open',
        settings: SETTINGS,
        signals: {}
      }
    ]);
  });

  it('ACC-SERIAL-2 ports with equal ids get keys numbered in getPorts() order, a port without ids its own family', async () => {
    const all = rig([
      new SimSerialPort(UNO),
      new SimSerialPort(UNO),
      new SimSerialPort()
    ]);
    await connect(all);

    expect(all.server.sent('claim').map(claim => claim.key)).toEqual([
      's:2341:0043:0',
      's:2341:0043:1',
      's:port:0'
    ]);
  });

  it.each([
    [8, 'even', 1],
    [7, 'odd', 2]
  ] as const)(
    'ACC-PROF-25 a port claimed with %i data bits, %s parity and %i stop bits is opened with them',
    async (dataBits, parity, stopBits) => {
      const port = new SimSerialPort(UNO);
      const all = rig([port]);
      all.server.settings = { baudRate: 115200, dataBits, parity, stopBits };
      await connect(all);

      expect(port.opens).toEqual([
        expect.objectContaining({ dataBits, parity, stopBits })
      ]);
    }
  );

  it('ACC-SERIAL-17 a port the browser cannot open reports state error with the reason text of the browser', async () => {
    const port = new SimSerialPort(UNO);
    port.openError = new DOMException(
      'Failed to open serial port.',
      'NetworkError'
    );
    const all = rig([port]);
    await connect(all);

    expect(
      all.server.sent('serial-state').map(state => [state.state, state.error])
    ).toEqual([
      ['opening', undefined],
      ['error', 'Failed to open serial port.']
    ]);

    // The next configure tries the open again and answers with the same error.
    const refused = all.server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: SETTINGS
    });
    await tick();
    expect(all.server.ack(refused)).toEqual({
      type: 'ack',
      seq: refused,
      ok: false,
      error: { name: 'NetworkError', message: 'Failed to open serial port.' }
    });

    // Bytes for a port that is not open: a command is refused, a frame is dropped.
    const write = all.server.command({
      type: 'serial-write',
      name: UNO_NAME,
      data: toBase64([1])
    });
    all.server.sendData(1, [2]);
    await tick();
    expect(all.server.ack(write)).toEqual({
      type: 'ack',
      seq: write,
      ok: false,
      error: { name: 'InvalidStateError', message: 'The port is not open' }
    });
    expect(port.written).toEqual([]);

    port.openError = null;
    const opened = all.server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: SETTINGS
    });
    await tick();
    expect(all.server.ack(opened)).toEqual(okAck(opened));
    const states = all.server.sent('serial-state');
    expect(states[states.length - 1]).toEqual({
      type: 'serial-state',
      name: UNO_NAME,
      state: 'open',
      settings: SETTINGS,
      signals: {}
    });
  });

  it('ACC-SERIAL-17 a port that is lost while open reports state error with the reason text of the browser', async () => {
    const { server, port } = await withPort();

    port.lose();
    await tick();

    const states = server.sent('serial-state');
    expect(states[states.length - 1]).toMatchObject({
      state: 'error',
      error: 'The device has been lost.'
    });
  });

  it('ACC-SERIAL-17 a port that refuses bytes reports state error with the reason text of the browser', async () => {
    const { server, port } = await withPort();
    port.writeError = new DOMException('The write failed.', 'NetworkError');

    server.sendData(1, [1, 2, 3]);
    await tick();

    const states = server.sent('serial-state');
    expect(states[states.length - 1]).toMatchObject({
      state: 'error',
      error: 'The write failed.'
    });
    expect(port.written).toEqual([]);
  });

  it('ACC-SEC-93 a port that getPorts() does not list is never opened, and the worker opens no grant dialog', async () => {
    const port = new SimSerialPort(UNO);
    const all = rig();
    // The port is plugged in and the dialog would give it, but nobody granted it.
    all.serial.dialog = port;
    await connect(all);

    all.server.send({
      type: 'claimed',
      key: UNO_KEY,
      ok: true,
      name: UNO_NAME,
      sid: 1,
      settings: SETTINGS
    });
    all.server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: SETTINGS
    });
    all.server.sendData(1, [1, 2, 3]);
    all.scope.post({ type: 'attach', keys: [UNO_KEY] });
    all.scope.post({ type: 'rescan' });
    all.serial.dispatchEvent(new Event('connect'));
    await tick(5000);

    expect(port.calls).toEqual([]);
    expect(all.serial.dialogs).toEqual([]);
    expect(all.usb.dialogs).toEqual([]);
    expect(all.server.sent('claim')).toEqual([]);
    // The worker gives back the device the server said it holds.
    expect(all.server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'removed' }
    ]);

    // After the grant of the user in the page, the same worker opens the port.
    await all.serial.requestPort();
    all.scope.post({ type: 'rescan' });
    await tick();
    expect(port.opens).toHaveLength(1);
  });

  it('ACC-SEC-94 a port whose claim the server refuses is not opened and is reported as not attached', async () => {
    const port = new SimSerialPort(UNO);
    const all = rig([port]);
    all.server.heldBy.set(UNO_KEY, 'tab-2');
    await connect(all);

    expect(port.calls).toEqual([]);
    expect(lastGrants(all.scope)).toEqual([
      { ...UNO_GRANT, name: null, attached: false }
    ]);
  });
});

describe('serial port: bytes and settings', () => {
  it('ACC-SERIAL-6 all 256 byte values from the port reach the server in a binary frame with the sid', async () => {
    const { server, port } = await withPort();

    port.receive(ALL_BYTES);
    await tick();

    expect(server.frames).toEqual([{ sid: 1, data: ALL_BYTES }]);
  });

  it('ACC-SERIAL-6 a read error that leaves the port open does not stop the bytes', async () => {
    const { server, port } = await withPort();

    port.breakRead(new DOMException('Framing error.', 'FramingError'));
    await tick();
    port.receive([5, 6]);
    await tick();

    expect(server.frames).toEqual([{ sid: 1, data: [5, 6] }]);
    expect(server.sent('serial-state').map(state => state.state)).toEqual([
      'opening',
      'open'
    ]);
  });

  it('ACC-SERIAL-6 bytes from a port that stayed open are not sent while its new claim has no answer', async () => {
    const { server, port } = await withPort();
    server.answerClaims = false;
    server.drop();
    await tick(500);
    expect(server.sent('claim')).toHaveLength(2);

    port.receive([1, 2, 3]);
    await tick();

    // The sid is of the connection before; the server gave none for this one yet.
    expect(server.frames).toEqual([]);
  });

  it('ACC-SERIAL-5 all 256 byte values of a binary frame reach the port with that sid, in order', async () => {
    const first = new SimSerialPort(UNO);
    const second = new SimSerialPort(UNO);
    const all = rig([first, second]);
    await connect(all);

    all.server.sendData(2, ALL_BYTES);
    await tick();

    expect(second.written).toEqual(ALL_BYTES);
    expect(first.written).toEqual([]);
  });

  it('ACC-SERIAL-9 a reconfigure ends the read loop, releases both stream locks and reopens the port at the new baud', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: { ...SETTINGS, baudRate: 57600 }
    });
    await tick();

    // The simulated close() rejects while a stream is locked, as the browser does.
    expect(server.ack(seq)).toEqual(okAck(seq));
    expect(port.calls.map(call => call.call)).toEqual([
      'open',
      'close',
      'open'
    ]);
    expect(port.opens[1].baudRate).toBe(57600);
    expect(server.sent('serial-state').map(state => state.state)).toEqual([
      'opening',
      'open',
      'closed',
      'opening',
      'open'
    ]);

    // The read loop of the reopened port moves bytes.
    port.receive([7]);
    await tick();
    expect(server.frames).toEqual([{ sid: 1, data: [7] }]);
  });

  it('ACC-SERIAL-9 a configure with the settings the port has does not reopen it', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: { ...SETTINGS }
    });
    await tick();

    expect(server.ack(seq)).toEqual(okAck(seq));
    expect(port.calls.map(call => call.call)).toEqual(['open']);
  });

  it('ACC-SERIAL-10 bytes issued right after a baud change reach the port only after the reopen at the new baud', async () => {
    const { server, port } = await withPort();
    port.echo = false;
    port.delay = 20;

    const configure = server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: { ...SETTINGS, baudRate: 57600 }
    });
    server.sendData(1, [1, 2, 3]);
    const write = server.command({
      type: 'serial-write',
      name: UNO_NAME,
      data: toBase64([4, 5])
    });

    // close() and open() take 20 ms each: at 39 ms the port is not open again.
    await tick(39);
    expect(port.callsOf('write')).toEqual([]);
    expect(server.ack(write)).toBeUndefined();

    await tick(1);
    expect(port.calls.slice(1)).toEqual([
      { call: 'close' },
      { call: 'open', options: expect.objectContaining({ baudRate: 57600 }) },
      { call: 'write', baudRate: 57600, data: [1, 2, 3] },
      { call: 'write', baudRate: 57600, data: [4, 5] }
    ]);
    expect(server.ack(configure)).toEqual(okAck(configure));
    expect(server.ack(write)).toEqual(okAck(write));
  });

  it('ACC-SERIAL-5 bytes the port has not transmitted yet are transmitted before a baud change closes the port (DEF-SERIAL-2)', async () => {
    const { server, port } = await withPort();
    const bytes = ALL_BYTES.slice(0, 64);
    port.echo = false;
    // The port takes the write at once and needs 30 ms to transmit it.
    port.transmitDelay = 30;

    server.sendData(1, bytes);
    const configure = server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: { ...SETTINGS, baudRate: 57600 }
    });

    // The write is accepted and the port is still open: it transmits, and what the
    // device sends meanwhile still reaches the server.
    await tick(29);
    expect(port.calls.map(call => call.call)).toEqual(['open']);
    expect(server.ack(configure)).toBeUndefined();
    port.receive([7]);

    await tick(1);
    expect(server.frames).toEqual([{ sid: 1, data: [7] }]);
    expect(port.calls.slice(1)).toEqual([
      { call: 'write', baudRate: 115200, data: bytes },
      { call: 'close' },
      { call: 'open', options: expect.objectContaining({ baudRate: 57600 }) }
    ]);
    expect(port.written).toHaveLength(64);
    expect(server.ack(configure)).toEqual(okAck(configure));

    // The reopened port has a new writable stream.
    server.sendData(1, [9]);
    await tick(30);
    expect(port.calls[port.calls.length - 1]).toEqual({
      call: 'write',
      baudRate: 57600,
      data: [9]
    });
  });

  it('ACC-SERIAL-5 bytes the port has not transmitted yet are transmitted before a detach closes the port (DEF-SERIAL-2)', async () => {
    const { server, scope, port } = await withPort();
    const bytes = ALL_BYTES.slice(0, 64);
    port.echo = false;
    port.transmitDelay = 30;

    server.sendData(1, bytes);
    // The port has accepted the bytes and transmitted none when the user detaches it.
    await tick();
    expect(port.calls.map(call => call.call)).toEqual(['open']);
    scope.post({ type: 'detach', keys: [UNO_KEY] });
    await tick(30);

    expect(port.calls.slice(1)).toEqual([
      { call: 'write', baudRate: 115200, data: bytes },
      { call: 'close' }
    ]);
    expect(port.isOpen).toBe(false);
  });

  it('ACC-SERIAL-18 a port whose writable stream fails to close is closed all the same (DEF-SERIAL-2)', async () => {
    const { server, scope, port } = await withPort();
    port.writeError = new DOMException(
      'The device has been lost.',
      'NetworkError'
    );
    // The failed write puts the writable stream into its error state.
    server.sendData(1, [1]);
    await tick();

    scope.post({ type: 'detach', keys: [UNO_KEY] });
    await tick();

    expect(port.calls.map(call => call.call)).toEqual(['open', 'close']);
    expect(port.isOpen).toBe(false);
    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'detach' }
    ]);
  });

  it('ACC-SERIAL-5 a binary frame of another type than 0x01 is not written to a port', async () => {
    const { server, port } = await withPort();

    server.socket.deliver(Uint8Array.from([0x02, 0, 1, 9, 9]).buffer);
    await tick();

    expect(port.written).toEqual([]);
  });

  it('ACC-MON-43 serial-write writes the base64 bytes to the port', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-write',
      name: UNO_NAME,
      data: toBase64(ALL_BYTES)
    });
    await tick();

    expect(server.ack(seq)).toEqual(okAck(seq));
    expect(port.written).toEqual(ALL_BYTES);
  });

  it('ACC-PANEL-65 the byte counters are sent once a second while they change', async () => {
    const { server, port } = await withPort();

    port.receive([1, 2, 3]);
    server.sendData(1, [9, 9]);
    await tick(1000);
    // 3 bytes from the device and the echo of the 2 written bytes.
    expect(server.sent('stats')).toEqual([
      { type: 'stats', name: UNO_NAME, rx: 5, tx: 2 }
    ]);

    await tick(3000);
    expect(server.sent('stats')).toHaveLength(1);

    port.receive([4]);
    await tick(1000);
    expect(server.sent('stats')[1]).toEqual({
      type: 'stats',
      name: UNO_NAME,
      rx: 6,
      tx: 2
    });
  });
});

describe('serial port: control lines and actions', () => {
  it('ACC-SHIM-33 serial-signals sets the lines the server names, in order, and reports them', async () => {
    const { server, port } = await withPort();

    const seqs = [
      server.command({ type: 'serial-signals', name: UNO_NAME, dtr: true }),
      server.command({
        type: 'serial-signals',
        name: UNO_NAME,
        dtr: false,
        rts: true
      }),
      server.command({ type: 'serial-signals', name: UNO_NAME, brk: true })
    ];
    await tick();

    seqs.forEach(seq => expect(server.ack(seq)).toEqual(okAck(seq)));
    expect(port.signals).toEqual([
      { dataTerminalReady: true },
      { dataTerminalReady: false, requestToSend: true },
      { break: true }
    ]);
    const states = server.sent('serial-state');
    expect(states[states.length - 1].signals).toEqual({
      dtr: false,
      rts: true,
      brk: true
    });
  });

  it('ACC-SHIM-33 a line the server sends as null is not set', async () => {
    const { server, port } = await withPort();
    const unset = null as unknown as undefined;

    server.command({
      type: 'serial-signals',
      name: UNO_NAME,
      dtr: true,
      rts: unset,
      brk: unset
    });
    await tick();

    // The simulated port keeps a null as the browser would: as a line set to false.
    expect(port.signals).toEqual([{ dataTerminalReady: true }]);
  });

  it('ACC-PROF-26 pulse-dtr sets DTR false, waits 100 ms, then sets DTR true', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'pulse-dtr'
    });
    await tick(99);
    expect(port.signals).toEqual([{ dataTerminalReady: false }]);
    expect(server.ack(seq)).toBeUndefined();

    await tick(1);
    expect(port.signals).toEqual([
      { dataTerminalReady: false },
      { dataTerminalReady: true }
    ]);
    expect(server.ack(seq)).toEqual(okAck(seq));
  });

  it('ACC-PROF-27 pulse-rts sets RTS false, waits 100 ms, then sets RTS true', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'pulse-rts'
    });
    await tick(99);
    expect(port.signals).toEqual([{ requestToSend: false }]);

    await tick(1);
    expect(port.signals).toEqual([
      { requestToSend: false },
      { requestToSend: true }
    ]);
    expect(server.ack(seq)).toEqual(okAck(seq));
  });

  it('ACC-PROF-28 esp-bootloader sets DTR false with RTS true, after 100 ms DTR true with RTS false, after 50 ms both false', async () => {
    const { server, port } = await withPort();
    const steps = [
      { dataTerminalReady: false, requestToSend: true },
      { dataTerminalReady: true, requestToSend: false },
      { dataTerminalReady: false, requestToSend: false }
    ];

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'esp-bootloader'
    });
    await tick(99);
    expect(port.signals).toEqual(steps.slice(0, 1));
    await tick(1);
    expect(port.signals).toEqual(steps.slice(0, 2));
    await tick(49);
    expect(port.signals).toEqual(steps.slice(0, 2));
    expect(server.ack(seq)).toBeUndefined();
    await tick(1);
    expect(port.signals).toEqual(steps);
    expect(server.ack(seq)).toEqual(okAck(seq));
  });

  it('ACC-PROF-29 touch-1200 opens the port at 1200 baud, sets DTR false, closes it, and after 500 ms opens it with the previous settings', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'touch-1200'
    });
    await tick(499);
    expect(port.calls.slice(1)).toEqual([
      { call: 'close' },
      { call: 'open', options: { ...port.opens[0], baudRate: 1200 } },
      { call: 'setSignals', signals: { dataTerminalReady: false } },
      { call: 'close' }
    ]);
    expect(server.ack(seq)).toBeUndefined();

    await tick(1);
    expect(port.calls.slice(5)).toEqual([
      { call: 'open', options: port.opens[0] }
    ]);
    expect(port.opens[0].baudRate).toBe(115200);
    expect(server.ack(seq)).toEqual(okAck(seq));
  });

  it('ACC-PROF-29 touch-1200 does not open a port again that was unplugged during the wait', async () => {
    const { server, serial, port } = await withPort();

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'touch-1200'
    });
    await tick(100);
    serial.unplug(port);
    await tick(400);

    expect(port.opens.map(options => options.baudRate)).toEqual([115200, 1200]);
    expect(server.ack(seq)).toEqual(okAck(seq));
  });

  it('ACC-PROF-32 an action the worker does not know is refused and changes no control line', async () => {
    const { server, port } = await withPort();

    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'pulse-cts' as 'none'
    });
    await tick(1000);

    expect(server.ack(seq)).toEqual({
      type: 'ack',
      seq,
      ok: false,
      error: { name: 'TypeError', message: 'Unknown action pulse-cts' }
    });
    expect(port.signals).toEqual([]);
  });

  it('ACC-PROF-30 a claim, a reconfigure and the action none change no control line', async () => {
    const { server, port } = await withPort();

    server.command({
      type: 'serial-configure',
      name: UNO_NAME,
      settings: { ...SETTINGS, baudRate: 19200 }
    });
    const seq = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'none'
    });
    await tick(1000);

    expect(server.ack(seq)).toEqual(okAck(seq));
    expect(port.opens).toHaveLength(2);
    expect(port.signals).toEqual([]);
  });
});

describe('serial port: ownership', () => {
  it('ACC-SERIAL-16 an unplugged port is released with reason removed', async () => {
    const { server, serial, scope, port } = await withPort();

    serial.unplug(port);
    await tick();

    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'removed' }
    ]);
    expect(lastGrants(scope)).toEqual([]);
  });

  it('ACC-SERIAL-16 a granted port that appears is claimed and opened', async () => {
    const all = rig();
    await connect(all);
    const port = new SimSerialPort(UNO);

    all.serial.plug(port);
    await tick();

    expect(all.server.sent('claim').map(claim => claim.key)).toEqual([UNO_KEY]);
    expect(port.opens).toHaveLength(1);
  });

  it('ACC-SERIAL-16 a late second answer to a claim does not release a port this tab holds', async () => {
    const { server, port } = await withPort();

    server.send({
      type: 'claimed',
      key: UNO_KEY,
      ok: true,
      name: UNO_NAME,
      sid: 1,
      settings: SETTINGS
    });
    await tick();

    expect(server.sent('release')).toEqual([]);
    expect(port.isOpen).toBe(true);
  });

  it('ACC-SERIAL-18 detach closes the port, keeps the grant and sends release detach; attach claims it again', async () => {
    const { server, scope, port } = await withPort();

    scope.post({ type: 'detach', keys: [UNO_KEY] });
    await tick();

    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'detach' }
    ]);
    expect(port.calls.map(call => call.call)).toEqual(['open', 'close']);
    expect(port.isOpen).toBe(false);
    expect(lastGrants(scope)).toEqual([
      { ...UNO_GRANT, name: UNO_NAME, attached: false }
    ]);

    // A command for a port this tab does not hold is refused.
    const seq = server.command({
      type: 'serial-write',
      name: UNO_NAME,
      data: toBase64([1])
    });
    await tick();
    expect(server.ack(seq)).toEqual({
      type: 'ack',
      seq,
      ok: false,
      error: {
        name: 'NotFoundError',
        message: `Serial port ${UNO_NAME} is not attached to this tab`
      }
    });

    scope.post({ type: 'attach', keys: [UNO_KEY] });
    await tick();
    expect(server.sent('claim')).toHaveLength(2);
    expect(port.isOpen).toBe(true);
    expect(lastGrants(scope)).toEqual([
      { ...UNO_GRANT, name: UNO_NAME, attached: true }
    ]);
  });

  it('ACC-SERIAL-19 forget closes the port, revokes the grant and sends release forget', async () => {
    const { server, scope, port } = await withPort();

    scope.post({ type: 'forget', name: UNO_NAME, keys: [UNO_KEY] });
    await tick();

    expect(port.calls.map(call => call.call)).toEqual([
      'open',
      'close',
      'forget'
    ]);
    expect(server.sent('release')).toEqual([
      { type: 'release', name: UNO_NAME, reason: 'forget' }
    ]);
    expect(lastGrants(scope)).toEqual([]);

    scope.post({ type: 'rescan' });
    await tick();
    expect(server.sent('claim')).toHaveLength(1);
  });
});

describe('WebSocket', () => {
  it('ACC-SERIAL-15 a ping goes out on connect and every 2 s, and the pong gives the round trip to the page', async () => {
    const all = rig();
    all.server.pongDelay = 30;
    await connect(all);

    expect(all.server.sent('ping')).toHaveLength(1);
    expect(all.scope.postedOf('rtt')).toEqual([]);

    await tick(30);
    expect(all.scope.postedOf('rtt')).toEqual([{ type: 'rtt', ms: 30 }]);

    await tick(1969);
    expect(all.server.sent('ping')).toHaveLength(1);
    await tick(1);
    expect(all.server.sent('ping')).toHaveLength(2);
    await tick(2000);
    expect(all.server.sent('ping')).toHaveLength(3);
  });

  it('ACC-SERIAL-4 after the WebSocket closes the worker connects again after 500 ms and claims every granted device again; the port stays open', async () => {
    const { server, scope, port } = await withPort();

    server.drop();
    expect(scope.postedOf('closed')).toHaveLength(1);
    expect(lastGrants(scope)).toEqual([
      { ...UNO_GRANT, name: UNO_NAME, attached: false }
    ]);

    await tick(499);
    expect(server.sockets).toHaveLength(1);
    await tick(1);

    expect(server.sockets).toHaveLength(2);
    expect(server.sent('hello')).toHaveLength(2);
    expect(server.sent('claim').map(claim => claim.key)).toEqual([
      UNO_KEY,
      UNO_KEY
    ]);
    expect(port.calls.map(call => call.call)).toEqual(['open']);
    // The server may be a new one: it gets the state of the port again.
    expect(server.sent('serial-state').map(state => state.state)).toEqual([
      'opening',
      'open',
      'open'
    ]);
    expect(lastGrants(scope)).toEqual([
      { ...UNO_GRANT, name: UNO_NAME, attached: true }
    ]);
  });

  it('ACC-SERIAL-4 the wait before a new connection doubles from 500 ms up to 10 s, and starts at 500 ms again after a connection', async () => {
    const all = rig();
    await connect(all);
    all.server.accepting = false;
    all.server.drop();

    let sockets = 1;
    for (const wait of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      await tick(wait - 1);
      expect(all.server.sockets).toHaveLength(sockets);
      await tick(1);
      sockets++;
      expect(all.server.sockets).toHaveLength(sockets);
    }

    all.server.accepting = true;
    await tick(10000);
    expect(all.server.sent('hello')).toHaveLength(2);
    sockets++;

    all.server.drop();
    await tick(500);
    expect(all.server.sockets).toHaveLength(sockets + 1);
  });

  it('ACC-SERIAL-18 a detached port is not claimed again after a reconnect', async () => {
    const { server, scope } = await withPort();
    scope.post({ type: 'detach', keys: [UNO_KEY] });
    await tick();

    server.drop();
    await tick(500);

    expect(server.sent('hello')).toHaveLength(2);
    expect(server.sent('claim')).toHaveLength(1);
  });

  it('ACC-SEC-94 a port that stayed open is closed when the server refuses the claim after a reconnect', async () => {
    const { server, port } = await withPort();

    server.heldBy.set(UNO_KEY, 'tab-2');
    server.drop();
    await tick(500);

    expect(server.sent('claim')).toHaveLength(2);
    expect(port.calls.map(call => call.call)).toEqual(['open', 'close']);
    expect(port.isOpen).toBe(false);
  });

  it('ACC-PANEL-70 without device interfaces the worker says so in hello and passes the table of the server to the page', async () => {
    const server = new SimServer();
    const scope = new SimScope(server);
    workerMain(scope);
    scope.post({ type: 'start', url: WS_URL });
    await tick();

    expect(server.received[0]).toEqual({
      type: 'hello',
      tabId: 'tab-1',
      serial: false,
      usb: false
    });
    expect(scope.posted.map(message => message.type)).toEqual(
      expect.arrayContaining(['welcome', 'devices', 'requests', 'grants'])
    );
    expect(scope.postedOf('welcome')[0].tabId).toBe('tab-1');
  });

  it('ACC-PANEL-70 without crypto.randomUUID, as on plain http, the worker makes its own tab id', async () => {
    const server = new SimServer();
    const scope = new SimScope(server);
    (scope.crypto as { randomUUID?: () => string }).randomUUID = undefined;
    workerMain(scope);
    scope.post({ type: 'start', url: WS_URL });
    await tick();

    expect(server.sent('hello')[0].tabId).toMatch(/^tab-[0-9a-f]+$/);
  });
});

describe('USB device', () => {
  it('ACC-USB-46 a granted USB device is claimed on connect and its descriptors are sent; the claim opens nothing', async () => {
    const { server, device } = await withDevice();

    expect(server.sent('claim')).toEqual([
      {
        type: 'claim',
        kind: 'usb',
        key: PROBE_KEY,
        info: {
          vendorId: 0x0d28,
          productId: 0x0204,
          serialNumber: 'SIM0001',
          productName: 'Simulated Probe',
          manufacturerName: 'Simulation'
        }
      }
    ]);
    expect(device.calls).toEqual([]);

    const endpoints = [
      { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
      { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
      { endpointNumber: 2, direction: 'out', type: 'interrupt', packetSize: 8 },
      { endpointNumber: 2, direction: 'in', type: 'interrupt', packetSize: 8 }
    ];
    const alternate = {
      interfaceClass: 0xff,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      interfaceName: null,
      endpoints
    };
    expect(server.sent('usb-descriptors')).toEqual([
      {
        type: 'usb-descriptors',
        name: PROBE_NAME,
        descriptors: {
          usbVersionMajor: 2,
          usbVersionMinor: 0,
          usbVersionSubminor: 0,
          deviceClass: 0xff,
          deviceSubclass: 0,
          deviceProtocol: 0,
          vendorId: 0x0d28,
          productId: 0x0204,
          deviceVersionMajor: 1,
          deviceVersionMinor: 2,
          deviceVersionSubminor: 3,
          manufacturerName: 'Simulation',
          productName: 'Simulated Probe',
          serialNumber: 'SIM0001',
          opened: false,
          configurationValue: null,
          configurations: [
            {
              configurationValue: 1,
              configurationName: 'Default',
              interfaces: [
                {
                  interfaceNumber: 0,
                  claimed: false,
                  alternateSetting: 0,
                  alternates: [
                    { alternateSetting: 0, ...alternate },
                    { alternateSetting: 1, ...alternate }
                  ]
                }
              ]
            }
          ]
        }
      }
    ]);
  });

  it('ACC-USB-46 USB devices without a serial number are claimed with numbered keys', async () => {
    const all = rig(
      [],
      [
        new SimUsbDevice({ serialNumber: null }),
        new SimUsbDevice({ serialNumber: null })
      ]
    );
    await connect(all);

    expect(all.server.sent('claim').map(claim => claim.key)).toEqual([
      'u:0d28:0204:#0',
      'u:0d28:0204:#1'
    ]);
    expect(all.server.sent('claim')[0].info).not.toHaveProperty('serialNumber');
  });

  it('ACC-USB-52 open and close reach the browser device, and open sends the raw descriptors', async () => {
    const { server, device } = await withDevice();

    const open = server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    await tick();
    expect(server.ack(open)).toEqual(okAck(open));
    expect(device.opened).toBe(true);
    const { descriptors } = server.sent('usb-descriptors')[1];
    expect(descriptors.opened).toBe(true);
    expect(descriptors.configurationValue).toBe(1);
    expect(fromBase64(descriptors.raw!.device)).toEqual(
      device.deviceDescriptor
    );
    expect(descriptors.raw!.configurations.map(fromBase64)).toEqual([
      device.configurationDescriptor
    ]);

    const close = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'close'
    });
    await tick();
    expect(server.ack(close)).toEqual(okAck(close));
    expect(device.opened).toBe(false);
    expect(device.callsOf('open')).toHaveLength(1);
    expect(device.callsOf('close')).toHaveLength(1);
  });

  it('ACC-USB-51 a device that refuses its raw descriptors is still opened, and the descriptors say why they are absent', async () => {
    const { server, device } = await withDevice();
    device.stalled.add(CONTROL_ENDPOINT);

    const open = server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    await tick();

    expect(server.ack(open)).toEqual(okAck(open));
    expect(device.opened).toBe(true);
    const { descriptors } = server.sent('usb-descriptors')[1];
    expect(descriptors.opened).toBe(true);
    expect(descriptors.configurations).toHaveLength(1);
    expect(descriptors.raw).toBeUndefined();
    expect(descriptors.rawError).toEqual({
      name: 'NetworkError',
      message: 'GET_DESCRIPTOR answered stall'
    });
  });

  it('ACC-USB-60 an operation the worker does not know is refused by name', async () => {
    const { server, device } = await withDevice(true);
    const before = device.calls.length;

    const seq = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'isochronous-in' as 'reset'
    });
    await tick();

    expect(server.ack(seq)).toEqual({
      type: 'ack',
      seq,
      ok: false,
      error: {
        name: 'NotSupportedError',
        message: 'Unknown USB operation isochronous-in'
      }
    });
    expect(device.calls).toHaveLength(before);
  });

  it('ACC-USB-53 select configuration, claim interface, select alternate and release interface reach the device with their numbers', async () => {
    const { server, device } = await withDevice(true);
    const before = device.calls.length;

    const seqs = [
      server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'select-configuration',
        args: { configurationValue: 1 }
      }),
      server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'claim-interface',
        args: { interfaceNumber: 0 }
      }),
      server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'select-alternate',
        args: { interfaceNumber: 0, alternateSetting: 1 }
      }),
      server.command({
        type: 'usb',
        name: PROBE_NAME,
        op: 'release-interface',
        args: { interfaceNumber: 0 }
      })
    ];
    await tick();

    seqs.forEach(seq => expect(server.ack(seq)).toEqual(okAck(seq)));
    expect(device.calls.slice(before)).toEqual([
      ['selectConfiguration', 1],
      ['claimInterface', 0],
      ['selectAlternateInterface', 0, 1],
      ['releaseInterface', 0]
    ]);
  });

  it('ACC-USB-54 control transfer in returns the bytes of the device and control transfer out delivers the bytes of the caller', async () => {
    const { server, device } = await withDevice(true);
    const vendor = {
      requestType: 'vendor',
      recipient: 'interface',
      request: 0x42,
      value: 7,
      index: 0
    } as const;

    const descriptor = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'control-in',
      args: {
        requestType: 'standard',
        recipient: 'device',
        request: 6,
        value: 0x0100,
        index: 0,
        length: 18
      }
    });
    const out = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'control-out',
      args: { ...vendor, data: toBase64([1, 2, 3, 250]) }
    });
    const back = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'control-in',
      args: { ...vendor, length: 64 }
    });
    await tick();

    expect(server.ack(descriptor)).toEqual({
      ...okAck(descriptor),
      result: { status: 'ok', data: toBase64(device.deviceDescriptor) }
    });
    expect(server.ack(out)).toEqual({
      ...okAck(out),
      result: { status: 'ok', bytesWritten: 4 }
    });
    expect(device.callsOf('controlTransferOut')).toEqual([
      [vendor, [1, 2, 3, 250]]
    ]);
    expect(server.ack(back)).toEqual({
      ...okAck(back),
      result: { status: 'ok', data: toBase64([1, 2, 3, 250]) }
    });
  });

  it('ACC-USB-55 bulk transfer out delivers the bytes of the caller and bulk transfer in returns the bytes of the device', async () => {
    const { server, device } = await withDevice(true);

    const out = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-out',
      args: { endpointNumber: BULK_ENDPOINT, data: toBase64(ALL_BYTES) }
    });
    const back = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber: BULK_ENDPOINT, length: 512 }
    });
    await tick();

    expect(server.ack(out)).toEqual({
      ...okAck(out),
      result: { status: 'ok', bytesWritten: 256 }
    });
    expect(device.callsOf('transferOut')).toEqual([[BULK_ENDPOINT, ALL_BYTES]]);
    expect(device.callsOf('transferIn')).toEqual([[BULK_ENDPOINT, 512]]);
    expect(server.ack(back)).toEqual({
      ...okAck(back),
      result: { status: 'ok', data: toBase64(ALL_BYTES) }
    });
  });

  it('ACC-USB-56 interrupt transfer out and in use the operations of bulk', async () => {
    const { server, device } = await withDevice(true);

    const out = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-out',
      args: { endpointNumber: INTERRUPT_ENDPOINT, data: toBase64([1, 2]) }
    });
    const report = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber: INTERRUPT_ENDPOINT, length: 8 }
    });
    await tick();
    expect(server.ack(out)).toEqual({
      ...okAck(out),
      result: { status: 'ok', bytesWritten: 2 }
    });
    expect(device.callsOf('transferOut')).toEqual([
      [INTERRUPT_ENDPOINT, [1, 2]]
    ]);
    // The interrupt endpoint is no loopback: the transfer waits for a report.
    expect(server.ack(report)).toBeUndefined();

    device.send(INTERRUPT_ENDPOINT, [0xa5, 0x5a]);
    await tick();
    expect(server.ack(report)).toEqual({
      ...okAck(report),
      result: { status: 'ok', data: toBase64([0xa5, 0x5a]) }
    });
  });

  it('ACC-USB-57 clear halt and reset reach the browser device', async () => {
    const { server, device } = await withDevice(true);
    device.stalled.add(BULK_ENDPOINT);

    const clear = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'clear-halt',
      args: { direction: 'in', endpointNumber: BULK_ENDPOINT }
    });
    const reset = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'reset'
    });
    await tick();

    expect(server.ack(clear)).toEqual(okAck(clear));
    expect(server.ack(reset)).toEqual(okAck(reset));
    expect(device.callsOf('clearHalt')).toEqual([['in', BULK_ENDPOINT]]);
    expect(device.callsOf('reset')).toEqual([[]]);
    expect(device.stalled.size).toBe(0);
  });

  it('ACC-USB-60 a call the browser rejects is answered with the name and message of its DOMException', async () => {
    const { server, device } = await withDevice();

    // The device is closed: the simulated browser rejects as the real one does.
    const closed = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'claim-interface',
      args: { interfaceNumber: 0 }
    });
    await tick();
    expect(server.ack(closed)).toEqual({
      type: 'ack',
      seq: closed,
      ok: false,
      error: {
        name: 'InvalidStateError',
        message: 'The device must be opened first.'
      }
    });

    device.failNext = new DOMException(
      'Unable to claim interface.',
      'NetworkError'
    );
    const refused = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'claim-interface',
      args: { interfaceNumber: 0 }
    });
    await tick();
    expect(server.ack(refused)).toEqual({
      type: 'ack',
      seq: refused,
      ok: false,
      error: { name: 'NetworkError', message: 'Unable to claim interface.' }
    });
  });

  it('ACC-USB-61 a stalled transfer is answered as a result with status stall', async () => {
    const { server, device } = await withDevice(true);
    device.stalled.add(BULK_ENDPOINT);

    const stalledIn = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber: BULK_ENDPOINT, length: 64 }
    });
    const stalledOut = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-out',
      args: { endpointNumber: BULK_ENDPOINT, data: toBase64([1]) }
    });
    await tick();

    expect(server.ack(stalledIn)).toEqual({
      ...okAck(stalledIn),
      result: { status: 'stall', data: '' }
    });
    expect(server.ack(stalledOut)).toEqual({
      ...okAck(stalledOut),
      result: { status: 'stall', bytesWritten: 0 }
    });
  });

  it('ACC-PANEL-65 the byte counters of a USB device count transfers in both directions', async () => {
    const { server } = await withDevice(true);
    // The descriptors the worker read at open are not traffic of a program.
    await tick(1000);
    expect(server.sent('stats')).toEqual([]);

    server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-out',
      args: { endpointNumber: BULK_ENDPOINT, data: toBase64([1, 2, 3]) }
    });
    server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber: BULK_ENDPOINT, length: 64 }
    });
    await tick(1000);

    expect(server.sent('stats')).toEqual([
      { type: 'stats', name: PROBE_NAME, rx: 3, tx: 3 }
    ]);
  });
});

describe('USB device: a transfer in without an answer', () => {
  const transferIn = (
    server: SimServer,
    endpointNumber: number,
    timeout?: number
  ): number =>
    server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber, length: 64, timeout }
    });

  const bytesAck = (seq: number, bytes: number[]): IAckMessage => ({
    ...okAck(seq),
    result: { status: 'ok', data: toBase64(bytes) }
  });

  it('ACC-USB-62 after a transfer in that timed out, the next transfer in on that endpoint returns the bytes that arrived meanwhile', async () => {
    const { server, device } = await withDevice(true);

    const first = transferIn(server, BULK_ENDPOINT, 100);
    await tick(99);
    expect(server.ack(first)).toBeUndefined();
    await tick(1);
    expect(server.ack(first)).toEqual({
      type: 'ack',
      seq: first,
      ok: false,
      error: {
        name: 'TimeoutError',
        message: 'No data on endpoint 1 within 100 ms'
      }
    });

    // The device sends while no command waits. The transfer of the browser takes it.
    device.send(BULK_ENDPOINT, [1, 2, 3]);
    await tick();

    const second = transferIn(server, BULK_ENDPOINT, 100);
    await tick();
    expect(server.ack(second)).toEqual(bytesAck(second, [1, 2, 3]));
    expect(device.callsOf('transferIn')).toHaveLength(1);

    // The kept transfer is used up: the next command starts a new one.
    device.send(BULK_ENDPOINT, [4]);
    const third = transferIn(server, BULK_ENDPOINT, 100);
    await tick();
    expect(server.ack(third)).toEqual(bytesAck(third, [4]));
    expect(device.callsOf('transferIn')).toHaveLength(2);
  });

  it('ACC-USB-62 bytes that arrive after the next transfer in was issued go to that transfer in', async () => {
    const { server, device } = await withDevice(true);
    const first = transferIn(server, BULK_ENDPOINT, 100);
    await tick(100);
    expect(server.ack(first)).toMatchObject({ ok: false });

    const second = transferIn(server, BULK_ENDPOINT, 100);
    await tick(50);
    device.send(BULK_ENDPOINT, [7, 8]);
    await tick();

    expect(server.ack(second)).toEqual(bytesAck(second, [7, 8]));
    expect(device.callsOf('transferIn')).toHaveLength(1);
  });

  it('ACC-USB-62 a transfer in that the server gave up on without a word is handed to the next transfer in on that endpoint', async () => {
    const { server, device } = await withDevice(true);

    const first = transferIn(server, BULK_ENDPOINT);
    await tick(5000);
    expect(server.ack(first)).toBeUndefined();

    const second = transferIn(server, BULK_ENDPOINT);
    await tick();
    expect(server.ack(first)).toMatchObject({
      ok: false,
      error: { name: 'AbortError' }
    });

    device.send(BULK_ENDPOINT, [9, 8]);
    await tick();
    expect(server.ack(second)).toEqual(bytesAck(second, [9, 8]));
    expect(device.callsOf('transferIn')).toHaveLength(1);
  });

  it('ACC-USB-62 a kept transfer belongs to its endpoint only', async () => {
    const { server, device } = await withDevice(true);
    transferIn(server, BULK_ENDPOINT, 100);
    await tick(100);

    const report = transferIn(server, INTERRUPT_ENDPOINT, 100);
    device.send(BULK_ENDPOINT, [1]);
    device.send(INTERRUPT_ENDPOINT, [2]);
    await tick();

    expect(server.ack(report)).toEqual(bytesAck(report, [2]));
    expect(device.callsOf('transferIn')).toEqual([
      [BULK_ENDPOINT, 64],
      [INTERRUPT_ENDPOINT, 64]
    ]);
  });

  it('ACC-USB-62 close drops a kept transfer, so bytes of an ended session are not given to the next one', async () => {
    const { server, device } = await withDevice(true);
    transferIn(server, BULK_ENDPOINT, 100);
    await tick(100);
    device.send(BULK_ENDPOINT, [1, 2, 3]);

    server.command({ type: 'usb', name: PROBE_NAME, op: 'close' });
    server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    await tick();
    const fresh = transferIn(server, BULK_ENDPOINT, 100);
    await tick();

    expect(server.ack(fresh)).toBeUndefined();
    expect(device.callsOf('transferIn')).toHaveLength(2);
  });

  it('ACC-USB-63 an unplugged USB device is released with reason removed, and an operation on it fails', async () => {
    const { server, usb, scope, device } = await withDevice(true);
    const pending = transferIn(server, BULK_ENDPOINT);
    await tick();

    usb.unplug(device);
    await tick();

    expect(server.sent('release')).toEqual([
      { type: 'release', name: PROBE_NAME, reason: 'removed' }
    ]);
    expect(lastGrants(scope)).toEqual([]);
    // The transfer that was pending ends with the error of the browser.
    expect(server.ack(pending)).toEqual({
      type: 'ack',
      seq: pending,
      ok: false,
      error: { name: 'NetworkError', message: 'The device was disconnected.' }
    });

    const seq = server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    await tick();
    expect(server.ack(seq)).toEqual({
      type: 'ack',
      seq,
      ok: false,
      error: {
        name: 'NotFoundError',
        message: `USB device ${PROBE_NAME} is not attached to this tab`
      }
    });
  });
});

describe('device requests', () => {
  const PROBE_REQUEST = {
    id: 'request-1',
    kind: 'usb',
    vendorId: 0x0d28,
    productId: 0x0204,
    serialNumber: 'SIM0001'
  } as const;

  it('ACC-USB-48 a rescan with a device request claims the granted device and answers the request with its name', async () => {
    const all = rig();
    await connect(all);
    all.usb.dialog = new SimUsbDevice();
    await all.usb.requestDevice({ filters: [] });

    all.scope.post({ type: 'rescan', request: PROBE_REQUEST });
    await tick();

    expect(all.server.sent('claim').map(claim => claim.key)).toEqual([
      PROBE_KEY
    ]);
    expect(all.server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-1', ok: true, name: PROBE_NAME }
    ]);
  });

  it('ACC-USB-48 a request for a device this tab already holds is answered with its name at once', async () => {
    const { server, scope } = await withDevice();

    scope.post({ type: 'rescan', request: PROBE_REQUEST });
    await tick();

    expect(server.sent('claim')).toHaveLength(1);
    expect(server.sent('request-result')).toEqual([
      { type: 'request-result', id: 'request-1', ok: true, name: PROBE_NAME }
    ]);
  });

  it('ACC-USB-49 a request for a device another tab holds is answered as refused and names that tab', async () => {
    const all = rig([], [new SimUsbDevice()]);
    all.server.heldBy.set(PROBE_KEY, 'tab-2');
    await connect(all);

    all.scope.post({ type: 'rescan', request: PROBE_REQUEST });
    await tick();

    expect(all.server.sent('request-result')).toEqual([
      {
        type: 'request-result',
        id: 'request-1',
        ok: false,
        error: {
          name: 'InvalidStateError',
          message: 'The device is held by tab tab-2'
        }
      }
    ]);
  });

  it('ACC-USB-49 a request for a device the server refuses without a holder is answered as refused', async () => {
    const all = rig([], [new SimUsbDevice()]);
    all.server.refused.add(PROBE_KEY);
    await connect(all);

    all.scope.post({ type: 'rescan', request: PROBE_REQUEST });
    await tick();

    expect(all.server.sent('request-result')).toEqual([
      {
        type: 'request-result',
        id: 'request-1',
        ok: false,
        error: {
          name: 'InvalidStateError',
          message: 'The server refused the device'
        }
      }
    ]);
  });

  it('ACC-USB-49 a request whose device the browser does not list is answered as refused', async () => {
    const all = rig();
    await connect(all);

    all.scope.post({ type: 'rescan', request: PROBE_REQUEST });
    await tick();

    expect(all.server.sent('request-result')).toEqual([
      {
        type: 'request-result',
        id: 'request-1',
        ok: false,
        error: {
          name: 'NotFoundError',
          message: 'The browser does not list the granted device'
        }
      }
    ]);
  });

  it('ACC-USB-49 a request-result from the page reaches the server unchanged', async () => {
    const all = rig();
    await connect(all);
    const denied = {
      type: 'request-result',
      id: 'request-2',
      ok: false,
      error: { name: 'NotFoundError', message: 'No device selected.' }
    } as const;

    all.scope.post(denied);

    expect(all.server.sent('request-result')).toEqual([denied]);
  });
});

describe('default serial settings', () => {
  it('ACC-PROF-118 the claim of a serial port carries the default serial settings the page sent before start, and the claim of a USB device carries none', async () => {
    const all = rig([new SimSerialPort(UNO)], [new SimUsbDevice()]);
    all.scope.post({ type: 'defaults', serial: DEFAULTS });
    await connect(all);

    const [serial, usb] = all.server.sent('claim');
    expect(all.server.sent('claim')).toHaveLength(2);
    expect(serial).toEqual({
      type: 'claim',
      kind: 'serial',
      key: UNO_KEY,
      info: UNO,
      defaults: DEFAULTS
    });
    expect([usb.kind, usb.key]).toEqual(['usb', PROBE_KEY]);
    expect(usb).not.toHaveProperty('defaults');
  });

  it('ACC-PROF-118 without a defaults message of the page the claim of a serial port has no field defaults', async () => {
    const { server } = await withPort();

    expect(server.sent('claim')).toHaveLength(1);
    expect(server.sent('claim')[0]).not.toHaveProperty('defaults');
  });

  it('ACC-PROF-119 default serial settings that change reach the claim of the next port, and claim and open no port again', async () => {
    const port = new SimSerialPort(UNO);
    const all = rig([port]);
    all.scope.post({ type: 'defaults', serial: DEFAULTS });
    await connect(all);
    const changed: ISerialDefaults = { ...DEFAULTS, baudRate: 57600 };

    all.scope.post({ type: 'defaults', serial: changed });
    await tick();
    expect(all.server.sent('claim')).toHaveLength(1);
    expect(port.opens).toHaveLength(1);

    all.serial.plug(new SimSerialPort(UNO));
    await tick();

    expect(
      all.server.sent('claim').map(claim => [claim.key, claim.defaults])
    ).toEqual([
      [UNO_KEY, DEFAULTS],
      ['s:2341:0043:1', changed]
    ]);
    expect(all.server.sockets).toHaveLength(1);
  });

  it('ACC-PROF-119 the claim after a reconnect and the claim of an attach carry the default serial settings of that moment', async () => {
    const all = rig([new SimSerialPort(UNO)]);
    all.scope.post({ type: 'defaults', serial: DEFAULTS });
    await connect(all);
    const changed: ISerialDefaults = { ...DEFAULTS, onOpen: 'none' };
    all.scope.post({ type: 'defaults', serial: changed });

    all.server.drop();
    await tick(500);
    all.scope.post({ type: 'detach', keys: [UNO_KEY] });
    all.scope.post({ type: 'attach', keys: [UNO_KEY] });
    await tick();

    expect(all.server.sent('claim').map(claim => claim.defaults)).toEqual([
      DEFAULTS,
      changed,
      changed
    ]);
  });
});

describe('the worker as the browser runs it', () => {
  it('ACC-SERIAL-14 the text of workerMain moves bytes with nothing but the worker scope', async () => {
    // Jest rewrites the functions it loads for coverage. This test compiles the source
    // file itself with the options of the build, so the text is the text that ships.
    const node = <T>(name: string): T => jest.requireActual(name) as T;
    const fs = node<{ readFileSync(file: string, encoding: string): string }>(
      'fs'
    );
    const vm = node<{ runInNewContext(code: string, context: object): void }>(
      'vm'
    );
    const tsconfig = node<{ compilerOptions: object }>('../../tsconfig.json');
    const { options } = ts.convertCompilerOptionsFromJson(
      tsconfig.compilerOptions,
      __dirname
    );
    const { outputText } = ts.transpileModule(
      fs.readFileSync(`${__dirname}/../worker.ts`, 'utf8'),
      {
        fileName: 'worker.ts',
        compilerOptions: { ...options, module: ts.ModuleKind.CommonJS }
      }
    );
    const compiled: { workerMain?: (scope: unknown) => void } = {};
    vm.runInNewContext(outputText, { exports: compiled });
    const text = compiled.workerMain!.toString();

    const port = new SimSerialPort(UNO);
    const device = new SimUsbDevice();
    const server = new SimServer();
    const serial = new SimSerial(port);
    const scope = new SimScope(server, serial, new SimUsb(device));
    // As createWorker() builds it. The context has no global but `self`.
    vm.runInNewContext(`(${text})(self);`, { self: scope });
    scope.post({ type: 'start', url: WS_URL });
    await tick();

    port.receive([1, 2, 3]);
    server.sendData(1, [4, 5]);
    const action = server.command({
      type: 'serial-action',
      name: UNO_NAME,
      action: 'touch-1200'
    });
    const open = server.command({ type: 'usb', name: PROBE_NAME, op: 'open' });
    const read = server.command({
      type: 'usb',
      name: PROBE_NAME,
      op: 'transfer-in',
      args: { endpointNumber: BULK_ENDPOINT, length: 64, timeout: 100 }
    });
    await tick(2000);

    expect(server.frames).toEqual([
      { sid: 1, data: [1, 2, 3] },
      { sid: 1, data: [4, 5] }
    ]);
    expect(port.written).toEqual([4, 5]);
    expect(server.ack(action)).toEqual(okAck(action));
    expect(server.ack(open)).toEqual(okAck(open));
    expect(server.ack(read)).toMatchObject({ error: { name: 'TimeoutError' } });
    expect(server.sent('stats').length).toBeGreaterThan(0);
    expect(scope.postedOf('rtt').length).toBeGreaterThan(0);

    serial.unplug(port);
    server.drop();
    await tick(500);
    expect(server.sent('hello')).toHaveLength(2);
  });

  it('ACC-SERIAL-14 createWorker starts a dedicated worker from a Blob URL, so the labextension serves no extra file', () => {
    const started: string[] = [];
    const blobs: Blob[] = [];
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.Worker = class {
      constructor(url: string) {
        started.push(url);
      }
    };
    URL.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      return 'blob:lab/worker';
    };

    createWorker();

    expect(started).toEqual(['blob:lab/worker']);
    expect(blobs.map(blob => blob.type)).toEqual(['text/javascript']);
  });
});
