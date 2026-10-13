/**
 * The dedicated worker of the device bridge.
 *
 * `workerMain` is the whole worker: it owns the WebSocket to the server and every
 * serial port and USB device the browser lists as granted, and it moves every byte.
 * The function is self-contained on purpose. `createWorker` ships its text through a
 * Blob URL, so at run time it can reach nothing outside its own body: no import, no
 * helper and no constant of this file. Types are the exception, they leave no code.
 */

import type {
  IClaimedMessage,
  IDeviceActivity,
  IErrorInfo,
  IGrant,
  IRescanMessage,
  ISerialClaimInfo,
  ISerialDefaults,
  ISerialSettings,
  ISerialSignals,
  IUsbClaimInfo,
  IUsbDescriptors,
  IUsbRawDescriptors,
  IUsbResult,
  PageToWorker,
  PortState,
  ReleaseReason,
  SerialAction,
  SerialCommand,
  ServerMessage,
  TabMessage,
  UsbCommand,
  WorkerToPage
} from './protocol';

/**
 * What `workerMain` uses of the worker global scope. In the browser this is `self`;
 * Jest passes a simulation.
 */
export interface IWorkerScope {
  navigator: { serial?: Serial; usb?: USB };
  WebSocket: new (url: string) => WebSocket;
  crypto: { randomUUID?: () => string };
  performance: { now(): number };
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  atob(data: string): string;
  btoa(data: string): string;
  postMessage(message: WorkerToPage): void;
  onmessage: ((event: { data: PageToWorker }) => void) | null;
}

/**
 * Run the worker on a worker global scope.
 *
 * The worker never asks for a grant. It takes devices only from
 * `navigator.serial.getPorts()` and `navigator.usb.getDevices()`, and lists them again
 * on a `connect` or `disconnect` event and when the page reports a new grant.
 *
 * @param scope The worker global scope, or a simulation of it
 */
export function workerMain(scope: IWorkerScope): void {
  const DATA_FRAME = 0x01;
  const PORT_BUFFER_BYTES = 65536;
  const PING_MS = 2000;
  const STATS_MS = 1000;
  const ACTIVITY_MS = 50;
  const BACKOFF_FIRST_MS = 500;
  const BACKOFF_MAX_MS = 10000;
  const TOUCH_BAUD = 1200;
  const TOUCH_WAIT_MS = 500;
  const GET_DESCRIPTOR = 6;
  const DEVICE_DESCRIPTOR = 0x0100;
  const CONFIGURATION_DESCRIPTOR = 0x0200;
  const DEVICE_DESCRIPTOR_BYTES = 18;
  const CONFIGURATION_HEADER_BYTES = 9;
  const BASE64_SLICE_BYTES = 0x8000;

  /** The signal steps of an action: the lines to set, then the wait in ms. */
  const ACTION_STEPS: { [action: string]: Array<[ISerialSignals, number]> } = {
    none: [],
    'pulse-dtr': [
      [{ dtr: false }, 100],
      [{ dtr: true }, 0]
    ],
    'pulse-rts': [
      [{ rts: false }, 100],
      [{ rts: true }, 0]
    ],
    'esp-bootloader': [
      [{ dtr: false, rts: true }, 100],
      [{ dtr: true, rts: false }, 50],
      [{ dtr: false, rts: false }, 0]
    ]
  };

  /**
   * Where a device stands with the server. `none`: to be claimed on the next listing.
   * `pending`: claim sent. `held`: this tab owns it. `refused`: another tab owns it.
   * `detached`: the user detached it. Only an attach claims a refused or detached device.
   */
  type Claim = 'none' | 'pending' | 'held' | 'refused' | 'detached';

  interface IEntryBase {
    key: string;
    name: string | null;
    claim: Claim;
    /** The device request to answer when the claim is answered. */
    requestId: string | null;
    ids: { vendorId?: number; productId?: number; serialNumber?: string };
    rx: number;
    tx: number;
    sentRx: number;
    sentTx: number;
    /** The counters at the last look for activity. */
    seenRx: number;
    seenTx: number;
  }

  interface ISerialEntry extends IEntryBase {
    kind: 'serial';
    device: SerialPort;
    info: ISerialClaimInfo;
    sid: number;
    state: PortState;
    /** True between a successful `open()` and the `close()` that follows it. */
    opened: boolean;
    settings: ISerialSettings | null;
    signals: ISerialSignals;
    error: string | null;
    /** The last `serial-state` sent, so an unchanged state is not sent twice. */
    reported: string;
    reading: boolean;
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    readDone: Promise<void>;
    writer: WritableStreamDefaultWriter<Uint8Array> | null;
    /** Every operation on the port runs through this one chain, in the order issued. */
    chain: Promise<unknown>;
  }

  interface IInOutcome {
    result?: USBInTransferResult;
    error?: unknown;
  }

  /** A `transferIn` that the browser still runs or has finished, and the command waiting for it. */
  interface IKeptTransfer {
    transfer: Promise<USBInTransferResult>;
    settle: ((outcome: IInOutcome) => void) | null;
  }

  interface IUsbEntry extends IEntryBase {
    kind: 'usb';
    device: USBDevice;
    info: IUsbClaimInfo;
    kept: Map<number, IKeptTransfer>;
  }

  type Entry = ISerialEntry | IUsbEntry;

  const nav = scope.navigator;
  // crypto.randomUUID exists only in a secure context. Without one the browser has no
  // device interface either, and the tab still shows the device table.
  const tabId = scope.crypto.randomUUID
    ? scope.crypto.randomUUID()
    : `tab-${Math.random().toString(16).slice(2)}`;
  const entries = new Map<string, Entry>();
  let url = '';
  /** The default serial settings the page sent last; undefined until it sends them. */
  let serialDefaults: ISerialDefaults | undefined;
  let socket: WebSocket | null = null;
  let connected = false;
  let backoff = BACKOFF_FIRST_MS;
  let pingTimer = 0;
  let statsTimer = 0;
  /** The timer of the look for activity; null while no device is open. */
  let activityTimer: number | null = null;
  let scanning: Promise<void> = Promise.resolve();

  // ---------------------------------------------------------------------- small tools

  const fail = (name: string, message: string): Error =>
    Object.assign(new Error(message), { name });

  const errorOf = (error: unknown): IErrorInfo => {
    const { name, message } = Object(error) as Partial<IErrorInfo>;
    return { name: name || 'Error', message: message || String(error) };
  };

  const fromBase64 = (text: string): Uint8Array => {
    const binary = scope.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_SLICE_BYTES) {
      binary += String.fromCharCode(
        ...bytes.subarray(i, i + BASE64_SLICE_BYTES)
      );
    }
    return scope.btoa(binary);
  };

  const hex = (id: number): string => id.toString(16).padStart(4, '0');

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      scope.setTimeout(resolve, ms);
    });

  const pick = <T, K extends keyof T>(source: T, keys: K[]): Pick<T, K> => {
    const copy = {} as Pick<T, K>;
    for (const key of keys) {
      copy[key] = source[key];
    }
    return copy;
  };

  const allEntries = (): Entry[] => Array.from(entries.values());

  const held = (name: string): Entry | undefined =>
    allEntries().find(entry => entry.claim === 'held' && entry.name === name);

  // ------------------------------------------------------------------- to the server

  const sendText = (text: string): void => {
    if (connected && socket) {
      socket.send(text);
    }
  };

  const send = (message: TabMessage): void => sendText(JSON.stringify(message));

  const postGrants = (): void => {
    const grants: IGrant[] = allEntries().map(entry => ({
      kind: entry.kind,
      key: entry.key,
      name: entry.name,
      attached: entry.claim === 'held',
      ...entry.ids
    }));
    scope.postMessage({ type: 'grants', grants });
  };

  // ------------------------------------------------------------- activity, to the page

  /**
   * Tell the page which devices moved bytes since the last look. The page lights its
   * lamps from this. It reads the counters only: the bytes and what the server gets
   * do not pass here.
   */
  const lookForActivity = (): void => {
    const devices: IDeviceActivity[] = [];
    for (const entry of allEntries()) {
      const rx = entry.rx > entry.seenRx;
      const tx = entry.tx > entry.seenTx;
      entry.seenRx = entry.rx;
      entry.seenTx = entry.tx;
      if ((rx || tx) && entry.name) {
        devices.push({ name: entry.name, rx, tx });
      }
    }
    if (devices.length > 0) {
      scope.postMessage({ type: 'activity', devices });
    }
  };

  /**
   * Run the look for activity only while a device is open. Called after every open
   * and every close of a device; a device that is removed or forgotten is closed.
   */
  const watchActivity = (): void => {
    const open = allEntries().some(entry =>
      entry.kind === 'serial' ? entry.opened : entry.device.opened
    );
    if (open && activityTimer === null) {
      // Bytes counted before now moved in no period of this timer.
      for (const entry of allEntries()) {
        entry.seenRx = entry.rx;
        entry.seenTx = entry.tx;
      }
      activityTimer = scope.setInterval(lookForActivity, ACTIVITY_MS);
    } else if (!open && activityTimer !== null) {
      scope.clearInterval(activityTimer);
      activityTimer = null;
    }
  };

  // --------------------------------------------------------------------- serial port

  const report = (entry: ISerialEntry): void => {
    if (entry.claim !== 'held' || !entry.name) {
      return;
    }
    const text = JSON.stringify({
      type: 'serial-state',
      name: entry.name,
      state: entry.state,
      settings: entry.settings,
      signals: entry.signals,
      error: entry.error || undefined
    } as TabMessage);
    if (text !== entry.reported) {
      entry.reported = text;
      sendText(text);
    }
  };

  const portFailed = (entry: ISerialEntry, error: unknown): void => {
    entry.state = 'error';
    entry.error = errorOf(error).message;
    report(entry);
  };

  /** Run a job on the port after every job issued before it, also after a failed one. */
  const enqueue = <T>(
    entry: ISerialEntry,
    job: () => Promise<T> | T
  ): Promise<T> => {
    const done = entry.chain.then(job);
    entry.chain = done.catch(() => undefined);
    return done;
  };

  const sendData = (entry: ISerialEntry, chunk: Uint8Array): void => {
    entry.rx += chunk.length;
    if (!connected || !socket || entry.claim !== 'held') {
      return;
    }
    const frame = new Uint8Array(chunk.length + 3);
    frame[0] = DATA_FRAME;
    frame[1] = entry.sid >> 8;
    frame[2] = entry.sid & 0xff;
    frame.set(chunk, 3);
    socket.send(frame);
  };

  const readLoop = async (entry: ISerialEntry): Promise<void> => {
    const port = entry.device;
    let lost: unknown = fail('NetworkError', 'The port stopped giving data');
    // `reading` is tested first: asking a cancelled port for `readable` makes a new stream.
    while (entry.reading && port.readable) {
      const reader = port.readable.getReader();
      entry.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          sendData(entry, value);
        }
      } catch (error) {
        // A framing, parity, overrun or break error ends this stream only and the port
        // gives a new one. A lost device gives none, and the loop ends below.
        lost = error;
      } finally {
        reader.releaseLock();
      }
    }
    entry.reader = null;
    if (entry.reading) {
      portFailed(entry, lost);
    }
  };

  const openPort = async (
    entry: ISerialEntry,
    settings: ISerialSettings
  ): Promise<void> => {
    const port = entry.device;
    entry.settings = settings;
    entry.state = 'opening';
    entry.error = null;
    report(entry);
    try {
      await port.open({
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        stopBits: settings.stopBits,
        parity: settings.parity,
        bufferSize: PORT_BUFFER_BYTES,
        flowControl: 'none'
      });
    } catch (error) {
      portFailed(entry, error);
      throw error;
    }
    entry.opened = true;
    watchActivity();
    entry.writer = port.writable!.getWriter();
    entry.reading = true;
    entry.readDone = readLoop(entry);
    entry.state = 'open';
    report(entry);
  };

  const closePort = async (entry: ISerialEntry): Promise<void> => {
    if (!entry.opened) {
      return;
    }
    if (entry.writer) {
      // close() of the port discards the bytes it has not transmitted yet. Closing
      // the writer first waits until they are transmitted. The read loop still runs
      // meanwhile, so what the device answers is not lost. A stream that already
      // failed rejects the close; the port is closed either way.
      await entry.writer.close().catch(() => undefined);
      entry.writer.releaseLock();
      entry.writer = null;
    }
    entry.reading = false;
    if (entry.reader) {
      // A stream that already failed rejects the cancel; the read loop ends either way.
      await entry.reader.cancel().catch(() => undefined);
    }
    await entry.readDone;
    // Both locks are released here: close() rejects while a stream is locked.
    entry.opened = false;
    watchActivity();
    entry.state = 'closed';
    entry.error = null;
    entry.signals = {};
    report(entry);
    await entry.device.close();
  };

  const sameSettings = (a: ISerialSettings, b: ISerialSettings): boolean =>
    a.baudRate === b.baudRate &&
    a.dataBits === b.dataBits &&
    a.parity === b.parity &&
    a.stopBits === b.stopBits;

  /** Web Serial takes settings only in open(), so new settings mean close and open. */
  const configure = async (
    entry: ISerialEntry,
    settings: ISerialSettings
  ): Promise<void> => {
    const current = entry.settings;
    if (entry.state === 'open' && current && sameSettings(current, settings)) {
      return;
    }
    await closePort(entry);
    await openPort(entry, settings);
  };

  const setSignals = async (
    entry: ISerialEntry,
    change: ISerialSignals
  ): Promise<void> => {
    // Only a line the server names with true or false is set. A null would reach the
    // port as false, and false on DTR or RTS resets a board.
    const lines: ISerialSignals = {};
    for (const line of ['dtr', 'rts', 'brk'] as const) {
      if (typeof change[line] === 'boolean') {
        lines[line] = change[line];
      }
    }
    await entry.device.setSignals({
      dataTerminalReady: lines.dtr,
      requestToSend: lines.rts,
      break: lines.brk
    });
    Object.assign(entry.signals, lines);
    report(entry);
  };

  const writePort = async (
    entry: ISerialEntry,
    bytes: Uint8Array
  ): Promise<void> => {
    if (!entry.writer) {
      throw fail('InvalidStateError', 'The port is not open');
    }
    await entry.writer.write(bytes);
    entry.tx += bytes.length;
  };

  const runAction = async (
    entry: ISerialEntry,
    action: SerialAction
  ): Promise<void> => {
    if (action === 'touch-1200') {
      const settings = entry.settings;
      if (!settings) {
        throw fail('InvalidStateError', 'The port has no settings yet');
      }
      await closePort(entry);
      await openPort(entry, { ...settings, baudRate: TOUCH_BAUD });
      await setSignals(entry, { dtr: false });
      await closePort(entry);
      await sleep(TOUCH_WAIT_MS);
      // A board that entered its bootloader is another device now; its port is gone.
      if (entries.get(entry.key) === entry) {
        await openPort(entry, settings);
      }
      return;
    }
    const steps = ACTION_STEPS[action];
    if (!steps) {
      throw fail('TypeError', `Unknown action ${action}`);
    }
    for (const [signals, wait] of steps) {
      await setSignals(entry, signals);
      if (wait) {
        await sleep(wait);
      }
    }
  };

  // ---------------------------------------------------------------------- USB device

  const inResult = (
    entry: IUsbEntry,
    result: USBInTransferResult
  ): IUsbResult => {
    const view = result.data;
    const bytes = view
      ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      : new Uint8Array(0);
    entry.rx += bytes.length;
    return { status: result.status, data: toBase64(bytes) };
  };

  const outResult = (
    entry: IUsbEntry,
    result: USBOutTransferResult
  ): IUsbResult => {
    entry.tx += result.bytesWritten;
    return { status: result.status, bytesWritten: result.bytesWritten };
  };

  const readDescriptor = async (
    device: USBDevice,
    value: number,
    length: number
  ): Promise<Uint8Array> => {
    const result = await device.controlTransferIn(
      {
        requestType: 'standard',
        recipient: 'device',
        request: GET_DESCRIPTOR,
        value,
        index: 0
      },
      length
    );
    const view = result.data;
    if (result.status !== 'ok' || !view) {
      throw fail('NetworkError', `GET_DESCRIPTOR answered ${result.status}`);
    }
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  };

  const rawDescriptors = async (
    device: USBDevice
  ): Promise<IUsbRawDescriptors> => {
    const raw: IUsbRawDescriptors = {
      device: toBase64(
        await readDescriptor(device, DEVICE_DESCRIPTOR, DEVICE_DESCRIPTOR_BYTES)
      ),
      configurations: []
    };
    for (let index = 0; index < device.configurations.length; index++) {
      const value = CONFIGURATION_DESCRIPTOR | index;
      // The header carries wTotalLength; the second read takes the whole descriptor.
      const header = await readDescriptor(
        device,
        value,
        CONFIGURATION_HEADER_BYTES
      );
      const total = header[2] | (header[3] << 8);
      raw.configurations.push(
        toBase64(await readDescriptor(device, value, total))
      );
    }
    return raw;
  };

  const sendDescriptors = async (entry: IUsbEntry): Promise<void> => {
    const device = entry.device;
    const descriptors: IUsbDescriptors = {
      ...pick(device, [
        'usbVersionMajor',
        'usbVersionMinor',
        'usbVersionSubminor',
        'deviceClass',
        'deviceSubclass',
        'deviceProtocol',
        'vendorId',
        'productId',
        'deviceVersionMajor',
        'deviceVersionMinor',
        'deviceVersionSubminor',
        'manufacturerName',
        'productName',
        'serialNumber',
        'opened'
      ]),
      configurationValue: device.configuration
        ? device.configuration.configurationValue
        : null,
      configurations: device.configurations.map(configuration => ({
        ...pick(configuration, ['configurationValue', 'configurationName']),
        interfaces: configuration.interfaces.map(iface => ({
          ...pick(iface, ['interfaceNumber', 'claimed']),
          // Chrome answers null for the alternate of an interface that is not claimed.
          alternateSetting: iface.alternate
            ? iface.alternate.alternateSetting
            : 0,
          alternates: iface.alternates.map(alternate => ({
            ...pick(alternate, [
              'alternateSetting',
              'interfaceClass',
              'interfaceSubclass',
              'interfaceProtocol',
              'interfaceName'
            ]),
            endpoints: alternate.endpoints.map(endpoint =>
              pick(endpoint, [
                'endpointNumber',
                'direction',
                'type',
                'packetSize'
              ])
            )
          }))
        }))
      }))
    };
    if (device.opened) {
      // The raw descriptors are an addition to the parsed ones. A device that refuses
      // the read is still open, so the refusal is reported and the operation goes on.
      try {
        descriptors.raw = await rawDescriptors(device);
      } catch (error) {
        descriptors.rawError = errorOf(error);
      }
    }
    if (entry.claim === 'held' && entry.name) {
      send({ type: 'usb-descriptors', name: entry.name, descriptors });
    }
  };

  /**
   * WebUSB has no timeout, so a transfer in that the caller gave up on stays pending in
   * the browser. It is kept per endpoint, and the next transfer in on that endpoint
   * takes its result instead of starting a second transfer that would miss the packet.
   */
  const transferIn = (
    entry: IUsbEntry,
    endpointNumber: number,
    length: number,
    timeout?: number
  ): Promise<IUsbResult> => {
    const forget = (kept: IKeptTransfer): void => {
      if (entry.kept.get(endpointNumber) === kept) {
        entry.kept.delete(endpointNumber);
      }
    };
    let found = entry.kept.get(endpointNumber);
    if (!found) {
      const started: IKeptTransfer = {
        transfer: entry.device.transferIn(endpointNumber, length),
        settle: null
      };
      entry.kept.set(endpointNumber, started);
      // A kept transfer that fails is dropped, so the next transfer in starts a new one.
      started.transfer.catch(() => forget(started));
      found = started;
    }
    const kept = found;
    if (kept.settle) {
      // One result goes to one command: the earlier command gives the transfer up.
      kept.settle({
        error: fail(
          'AbortError',
          `A later transfer in on endpoint ${endpointNumber} took this transfer over`
        )
      });
    }
    return new Promise<IUsbResult>((resolve, reject) => {
      let timer = 0;
      const settle = (outcome: IInOutcome): void => {
        if (kept.settle !== settle) {
          return;
        }
        kept.settle = null;
        scope.clearTimeout(timer);
        if (!outcome.result) {
          reject(outcome.error);
          return;
        }
        forget(kept);
        resolve(inResult(entry, outcome.result));
      };
      kept.settle = settle;
      kept.transfer.then(
        result => settle({ result }),
        error => settle({ error })
      );
      if (timeout) {
        timer = scope.setTimeout(() => {
          settle({
            error: fail(
              'TimeoutError',
              `No data on endpoint ${endpointNumber} within ${timeout} ms`
            )
          });
        }, timeout);
      }
    });
  };

  const usbOperation = async (
    message: UsbCommand
  ): Promise<IUsbResult | void> => {
    const entry = held(message.name);
    if (!entry || entry.kind !== 'usb') {
      throw fail(
        'NotFoundError',
        `USB device ${message.name} is not attached to this tab`
      );
    }
    const device = entry.device;
    switch (message.op) {
      case 'open':
        await device.open();
        watchActivity();
        return sendDescriptors(entry);
      case 'close':
        // Data that arrived before a close or a reset belongs to the session it ends.
        entry.kept.clear();
        await device.close();
        watchActivity();
        return;
      case 'reset':
        entry.kept.clear();
        return device.reset();
      case 'select-configuration':
        return device.selectConfiguration(message.args.configurationValue);
      case 'claim-interface':
        return device.claimInterface(message.args.interfaceNumber);
      case 'release-interface':
        return device.releaseInterface(message.args.interfaceNumber);
      case 'select-alternate':
        return device.selectAlternateInterface(
          message.args.interfaceNumber,
          message.args.alternateSetting
        );
      case 'clear-halt':
        return device.clearHalt(
          message.args.direction,
          message.args.endpointNumber
        );
      case 'control-in':
        return inResult(
          entry,
          await device.controlTransferIn(message.args, message.args.length)
        );
      case 'control-out':
        return outResult(
          entry,
          await device.controlTransferOut(
            message.args,
            message.args.data ? fromBase64(message.args.data) : undefined
          )
        );
      case 'transfer-in':
        return transferIn(
          entry,
          message.args.endpointNumber,
          message.args.length,
          message.args.timeout
        );
      case 'transfer-out':
        return outResult(
          entry,
          await device.transferOut(
            message.args.endpointNumber,
            fromBase64(message.args.data)
          )
        );
      default:
        throw fail(
          'NotSupportedError',
          `Unknown USB operation ${(message as { op: string }).op}`
        );
    }
  };

  // ----------------------------------------------------------------------- ownership

  const claim = (entry: Entry): void => {
    entry.claim = 'pending';
    send({
      type: 'claim',
      kind: entry.kind,
      key: entry.key,
      info: entry.info,
      // The server gives them to a serial port it has no record of. A field that is
      // undefined is not in the message.
      defaults: entry.kind === 'serial' ? serialDefaults : undefined
    });
  };

  /** Tell the server that this tab gives the device up, when it holds it. */
  const release = (entry: Entry, reason: ReleaseReason): void => {
    if (entry.claim === 'held' && entry.name) {
      send({ type: 'release', name: entry.name, reason });
    }
    entry.claim = reason === 'detach' ? 'detached' : 'none';
  };

  const closeDevice = (entry: Entry): Promise<void> => {
    if (entry.kind === 'serial') {
      return enqueue(entry, () => closePort(entry));
    }
    entry.kept.clear();
    const closed = entry.device.opened
      ? entry.device.close()
      : Promise.resolve();
    // The close of a device that is gone can fail; the look ends when none is open.
    return closed.finally(watchActivity);
  };

  /** The lowest key of a family that no device of this tab uses. */
  const freeKey = (family: string): string => {
    let n = 0;
    while (entries.has(family + n)) {
      n++;
    }
    return family + n;
  };

  const newEntry = (key: string, ids: IEntryBase['ids']): IEntryBase => ({
    key,
    name: null,
    claim: 'none',
    requestId: null,
    ids,
    rx: 0,
    tx: 0,
    sentRx: 0,
    sentTx: 0,
    seenRx: 0,
    seenTx: 0
  });

  const addSerial = (port: SerialPort): void => {
    const { usbVendorId, usbProductId } = port.getInfo();
    const family =
      usbVendorId === undefined || usbProductId === undefined
        ? 's:port:'
        : `s:${hex(usbVendorId)}:${hex(usbProductId)}:`;
    const key = freeKey(family);
    entries.set(key, {
      ...newEntry(key, { vendorId: usbVendorId, productId: usbProductId }),
      kind: 'serial',
      device: port,
      info: { usbVendorId, usbProductId },
      sid: 0,
      state: 'closed',
      opened: false,
      settings: null,
      signals: {},
      error: null,
      reported: '',
      reading: false,
      reader: null,
      readDone: Promise.resolve(),
      writer: null,
      chain: Promise.resolve()
    });
  };

  const addUsb = (device: USBDevice): void => {
    const { vendorId, productId } = device;
    const serialNumber = device.serialNumber || undefined;
    const family = `u:${hex(vendorId)}:${hex(productId)}:`;
    // Two devices with one serial number exist; the second takes a numbered key.
    const key =
      serialNumber && !entries.has(family + serialNumber)
        ? family + serialNumber
        : freeKey(`${family}#`);
    entries.set(key, {
      ...newEntry(key, { vendorId, productId, serialNumber }),
      kind: 'usb',
      device,
      info: {
        vendorId,
        productId,
        serialNumber,
        productName: device.productName || undefined,
        manufacturerName: device.manufacturerName || undefined
      },
      kept: new Map()
    });
  };

  /** Answer a device request with the device the user picked in the grant dialog. */
  const answerRequest = (request: NonNullable<IRescanMessage['request']>) => {
    if (!connected) {
      return;
    }
    const matches = allEntries().filter(
      entry =>
        entry.kind === request.kind &&
        entry.ids.vendorId === request.vendorId &&
        entry.ids.productId === request.productId &&
        entry.ids.serialNumber === request.serialNumber
    );
    // Of several devices with these ids, the picked one is the one not attached yet.
    const entry = matches.find(match => match.claim !== 'held') || matches[0];
    if (!entry) {
      send({
        type: 'request-result',
        id: request.id,
        ok: false,
        error: {
          name: 'NotFoundError',
          message: 'The browser does not list the granted device'
        }
      });
    } else if (entry.claim === 'held' && entry.name) {
      send({
        type: 'request-result',
        id: request.id,
        ok: true,
        name: entry.name
      });
    } else {
      entry.requestId = request.id;
      if (entry.claim !== 'pending') {
        claim(entry);
      }
    }
  };

  /** Make the entries equal to what the browser lists as granted and plugged in. */
  const listDevices = async (
    request?: IRescanMessage['request']
  ): Promise<void> => {
    const ports = nav.serial ? await nav.serial.getPorts() : [];
    const devices = nav.usb ? await nav.usb.getDevices() : [];
    const listed = new Set<SerialPort | USBDevice>([
      ...ports.filter(port => port.connected !== false),
      ...devices
    ]);
    const known = new Set<SerialPort | USBDevice>();
    for (const entry of allEntries()) {
      if (listed.has(entry.device)) {
        known.add(entry.device);
        continue;
      }
      entries.delete(entry.key);
      release(entry, 'removed');
      // The device is gone, so its close can fail. It still ends the read loop.
      closeDevice(entry).catch(() => undefined);
    }
    for (const device of listed) {
      if (known.has(device)) {
        continue;
      }
      if (ports.includes(device as SerialPort)) {
        addSerial(device as SerialPort);
      } else {
        addUsb(device as USBDevice);
      }
    }
    if (connected) {
      allEntries()
        .filter(entry => entry.claim === 'none')
        .forEach(claim);
    }
    if (request) {
      answerRequest(request);
    }
    postGrants();
  };

  /** One listing at a time, in the order asked. A failed listing does not block the next. */
  const scan = (request?: IRescanMessage['request']): Promise<void> => {
    const done = scanning.then(() => listDevices(request));
    scanning = done.catch(() => undefined);
    return done;
  };

  const onClaimed = (message: IClaimedMessage): void => {
    const entry = entries.get(message.key);
    if (!entry || entry.claim !== 'pending') {
      // The device left this tab while the claim was on its way: give it back. An
      // answer for a device this tab holds is the late answer to an earlier claim on
      // the same key, and changes nothing.
      const holds = entry !== undefined && entry.claim === 'held';
      if (message.ok && message.name && !holds) {
        send({
          type: 'release',
          name: message.name,
          reason: entry ? 'detach' : 'removed'
        });
      }
      return;
    }
    entry.claim = message.ok ? 'held' : 'refused';
    entry.name = message.name || entry.name;
    if (entry.requestId) {
      send({
        type: 'request-result',
        id: entry.requestId,
        ok: message.ok,
        name: message.ok ? message.name : undefined,
        error: message.ok
          ? undefined
          : {
              name: 'InvalidStateError',
              // The server names no holder when it could not make the device.
              message: message.heldBy
                ? `The device is held by tab ${message.heldBy}`
                : 'The server refused the device'
            }
      });
      entry.requestId = null;
    }
    postGrants();
    if (!message.ok) {
      // A port that stayed open while the WebSocket was down belongs to the other tab
      // now, and that tab cannot open it while this one holds it.
      closeDevice(entry).catch(() => undefined);
      return;
    }
    // The server may be a new one: it gets the counters and the state again.
    entry.sentRx = 0;
    entry.sentTx = 0;
    if (entry.kind === 'usb') {
      void sendDescriptors(entry);
      return;
    }
    entry.sid = message.sid || 0;
    entry.reported = '';
    // A port that stayed open while the WebSocket was down is not opened again.
    enqueue(entry, async () => {
      await configure(entry, message.settings as ISerialSettings);
      report(entry);
    }).catch(error => portFailed(entry, error));
  };

  // ----------------------------------------------------------------- server messages

  /** Answer a server command with one ack when its work ends. */
  const acknowledge = (seq: number, work: Promise<IUsbResult | void>): void => {
    work.then(
      result =>
        send({ type: 'ack', seq, ok: true, result: result || undefined }),
      error => send({ type: 'ack', seq, ok: false, error: errorOf(error) })
    );
  };

  const serialCommand = async (message: SerialCommand): Promise<void> => {
    const entry = held(message.name);
    if (!entry || entry.kind !== 'serial') {
      throw fail(
        'NotFoundError',
        `Serial port ${message.name} is not attached to this tab`
      );
    }
    return enqueue(entry, () => {
      switch (message.type) {
        case 'serial-configure':
          return configure(entry, message.settings);
        case 'serial-signals':
          return setSignals(entry, message);
        case 'serial-action':
          return runAction(entry, message.action);
        case 'serial-write':
          return writePort(entry, fromBase64(message.data));
      }
    });
  };

  const onText = (message: ServerMessage): void => {
    switch (message.type) {
      case 'welcome':
      case 'devices':
      case 'requests':
      case 'runs':
        scope.postMessage(message);
        return;
      case 'pong':
        scope.postMessage({
          type: 'rtt',
          ms: Math.round((scope.performance.now() - message.t) * 10) / 10
        });
        return;
      case 'claimed':
        onClaimed(message);
        return;
      case 'usb':
        acknowledge(message.seq, usbOperation(message));
        return;
      case 'serial-configure':
      case 'serial-signals':
      case 'serial-action':
      case 'serial-write':
        acknowledge(message.seq, serialCommand(message));
        return;
    }
  };

  /** A binary frame carries bytes for one port. */
  const onData = (frame: Uint8Array): void => {
    if (frame[0] !== DATA_FRAME) {
      return;
    }
    const sid = (frame[1] << 8) | frame[2];
    const entry = allEntries().find(
      (candidate): candidate is ISerialEntry =>
        candidate.kind === 'serial' &&
        candidate.claim === 'held' &&
        candidate.sid === sid
    );
    if (!entry) {
      return;
    }
    const bytes = frame.subarray(3);
    // The writer is tested when the job runs, not now: after a reconfigure issued
    // before this frame, the port is open again by then. Bytes for a port that is
    // not open then are dropped; its state already says why.
    enqueue(entry, () =>
      entry.writer ? writePort(entry, bytes) : undefined
    ).catch(error => portFailed(entry, error));
  };

  const sendStats = (): void => {
    for (const entry of allEntries()) {
      const changed = entry.rx !== entry.sentRx || entry.tx !== entry.sentTx;
      if (entry.claim === 'held' && entry.name && changed) {
        entry.sentRx = entry.rx;
        entry.sentTx = entry.tx;
        send({ type: 'stats', name: entry.name, rx: entry.rx, tx: entry.tx });
      }
    }
  };

  // ---------------------------------------------------------------------- connection

  const ping = (): void => send({ type: 'ping', t: scope.performance.now() });

  const connect = (): void => {
    const ws = new scope.WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = () => {
      connected = true;
      backoff = BACKOFF_FIRST_MS;
      send({ type: 'hello', tabId, serial: !!nav.serial, usb: !!nav.usb });
      ping();
      pingTimer = scope.setInterval(ping, PING_MS);
      statsTimer = scope.setInterval(sendStats, STATS_MS);
      void scan();
    };
    ws.onmessage = event => {
      if (typeof event.data === 'string') {
        onText(JSON.parse(event.data));
      } else {
        onData(new Uint8Array(event.data));
      }
    };
    ws.onclose = () => {
      connected = false;
      socket = null;
      scope.clearInterval(pingTimer);
      scope.clearInterval(statsTimer);
      // The server detached every device of this tab. The ports stay open, and each
      // device the user did not detach is claimed again on the next connection.
      for (const entry of allEntries()) {
        entry.requestId = null;
        if (entry.claim !== 'detached') {
          entry.claim = 'none';
        }
      }
      scope.postMessage({ type: 'closed' });
      postGrants();
      scope.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };

  // ----------------------------------------------------- page messages, device events

  scope.onmessage = event => {
    const message = event.data;
    switch (message.type) {
      case 'start':
        url = message.url;
        connect();
        return;
      case 'defaults':
        serialDefaults = message.serial;
        return;
      case 'rescan':
        void scan(message.request);
        return;
      case 'attach':
        for (const key of message.keys) {
          const entry = entries.get(key);
          if (entry && entry.claim !== 'held' && entry.claim !== 'pending') {
            entry.claim = 'none';
            if (connected) {
              claim(entry);
            }
          }
        }
        postGrants();
        return;
      case 'detach':
        for (const key of message.keys) {
          const entry = entries.get(key);
          if (entry) {
            release(entry, 'detach');
            void closeDevice(entry);
          }
        }
        postGrants();
        return;
      case 'forget':
        for (const key of message.keys) {
          const entry = entries.get(key);
          if (entry) {
            entries.delete(key);
            entry.claim = 'none';
            const forgetGrant = (): Promise<void> => entry.device.forget();
            void closeDevice(entry).then(forgetGrant, forgetGrant);
          }
        }
        send({ type: 'release', name: message.name, reason: 'forget' });
        postGrants();
        return;
      case 'request-result':
        send(message);
        return;
    }
  };

  const sources: Array<EventTarget | undefined> = [nav.serial, nav.usb];
  for (const source of sources) {
    if (source) {
      source.addEventListener('connect', () => void scan());
      source.addEventListener('disconnect', () => void scan());
    }
  }
}

/**
 * Start the dedicated worker from a Blob URL of the text of `workerMain`, so that the
 * labextension serves no extra file.
 *
 * The URL is not revoked. The worker loads it after this call returns, and a test
 * harness that wraps `Worker` loads it a second time with `importScripts`.
 *
 * @returns The running worker; it waits for a `start` message
 */
export function createWorker(): Worker {
  const source = `(${workerMain.toString()})(self);`;
  const blob = new Blob([source], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob));
}
