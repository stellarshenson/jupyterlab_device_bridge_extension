/**
 * Simulated devices, server and worker scope for the Jest tests.
 *
 * No test in this project reaches hardware. These classes stand where the browser
 * and the server stand: `navigator.serial`, `navigator.usb`, the WebSocket with the
 * server behind it, and the global scope of the dedicated worker. They follow the
 * Web Serial and WebUSB specifications where the worker depends on a rule, for
 * example `close()` rejecting while a stream is locked, `close()` discarding the
 * bytes a port has not transmitted yet, and a transfer in staying pending until the
 * device sends.
 */

import type {
  IAckMessage,
  IClaimMessage,
  IDeviceRequest,
  IDeviceTable,
  IProfile,
  ISerialClaimInfo,
  ISerialRecord,
  ISerialSettings,
  IUsbClaimInfo,
  IUsbRecord,
  PageToWorker,
  SerialCommand,
  ServerMessage,
  TabMessage,
  UsbCommand,
  WorkerToPage
} from '../protocol';
import type { IWorkerScope } from '../worker';

// The streams of Node, which jsdom does not offer as globals.
const web = jest.requireActual('stream/web') as {
  ReadableStream: typeof ReadableStream;
  WritableStream: typeof WritableStream;
};

const wait = (ms: number): Promise<void> =>
  ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

const hex = (id: number): string => id.toString(16).padStart(4, '0');

const flat = (lists: number[][]): number[] => ([] as number[]).concat(...lists);

const DEVICE_DIR = '/tmp/jupyterlab-device-1000';

const bytesOf = (data: BufferSource): number[] =>
  Array.from(
    ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
  );

/** Base64 text as the byte values it encodes. */
export const fromBase64 = (text: string): number[] =>
  Array.from(atob(text), char => char.charCodeAt(0));

/** Byte values as base64 text. */
export const toBase64 = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes));

// ------------------------------------------------------------------------ granting

/** What a simulated device needs for the grant list to hold it. */
interface IGrantable {
  forgotten: boolean;
  lose(): void;
}

/**
 * The part that `navigator.serial` and `navigator.usb` share: the devices granted to
 * the origin, the grant dialog, and the `connect` and `disconnect` events.
 */
class SimGrants<T extends IGrantable, O> extends EventTarget {
  /** Granted devices that are plugged in. */
  readonly granted: T[];
  /**
   * How the next grant dialog ends: with the device the user picks, or with the
   * error the browser rejects with. The default is a user who cancels.
   */
  dialog: T | Error = new DOMException('No device selected.', 'NotFoundError');
  /**
   * The options of every grant dialog call, in order; null for a call without options.
   * Never undefined: `toEqual` of Jest takes `[undefined]` and `[]` as equal, so an
   * assertion on this list could not see a call without options.
   */
  readonly dialogs: Array<O | null> = [];

  constructor(...granted: T[]) {
    super();
    this.granted = granted;
  }

  /** Plug in a device that has a grant; the browser fires `connect`. */
  plug(device: T): void {
    this.granted.push(device);
    this.dispatchEvent(new Event('connect'));
  }

  /** Pull a device out; the browser stops listing it and fires `disconnect`. */
  unplug(device: T): void {
    this.granted.splice(this.granted.indexOf(device), 1);
    device.lose();
    this.dispatchEvent(new Event('disconnect'));
  }

  protected async list(): Promise<T[]> {
    return this.granted.filter(device => !device.forgotten);
  }

  protected async ask(options?: O): Promise<T> {
    this.dialogs.push(options ?? null);
    if (this.dialog instanceof Error) {
      throw this.dialog;
    }
    if (!this.granted.includes(this.dialog)) {
      this.granted.push(this.dialog);
    }
    return this.dialog;
  }
}

// -------------------------------------------------------------------- serial port

/** One call that a simulated serial port received. */
export type PortCall =
  | { call: 'open'; options: SerialOptions }
  | { call: 'setSignals'; signals: SerialOutputSignals }
  | { call: 'write'; baudRate: number; data: number[] }
  | { call: 'close' }
  | { call: 'forget' };

/**
 * A serial port that echoes what is written to it and records every call.
 *
 * @example
 * const port = new SimSerialPort({ usbVendorId: 0x2341, usbProductId: 0x0043 });
 * port.openError = new DOMException('Failed to open serial port.', 'NetworkError');
 */
export class SimSerialPort implements IGrantable {
  /** Every call the port received, in order. */
  readonly calls: PortCall[] = [];
  /** While set, `open()` rejects with it. */
  openError: Error | null = null;
  /** While set, a write to the port rejects with it. */
  writeError: Error | null = null;
  /** Whether written bytes come back as received bytes. */
  echo = true;
  /** Milliseconds that `open()` and `close()` take. */
  delay = 0;
  /**
   * Milliseconds the port needs to transmit a chunk it accepted. The write resolves
   * at once, as with the transmit buffer of the operating system, and the `write`
   * call is recorded when the chunk is transmitted. As in the specification, closing
   * the writable stream waits until every chunk is transmitted, and `close()` of the
   * port discards the chunks that are not transmitted yet.
   */
  transmitDelay = 0;
  forgotten = false;

  constructor(private readonly info: SerialPortInfo = {}) {}

  /** False after the device was pulled out. */
  get connected(): boolean {
    return !this.lost;
  }

  /** The options of every `open()` call, in order. */
  get opens(): SerialOptions[] {
    return this.callsOf('open').map(c => c.options);
  }

  /** The argument of every `setSignals()` call, in order. */
  get signals(): SerialOutputSignals[] {
    return this.callsOf('setSignals').map(c => c.signals);
  }

  /** How many times `close()` was called. */
  get closes(): number {
    return this.callsOf('close').length;
  }

  /** Every byte written to the port, in order. */
  get written(): number[] {
    return flat(this.callsOf('write').map(c => c.data));
  }

  /** The calls of one kind, in order. */
  callsOf<K extends PortCall['call']>(
    call: K
  ): Array<Extract<PortCall, { call: K }>> {
    return this.calls.filter(
      (c): c is Extract<PortCall, { call: K }> => c.call === call
    );
  }

  /** Whether the port is open now. */
  get isOpen(): boolean {
    return this.options !== null;
  }

  /** As in the specification: null while closed, a new stream after one ended. */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.options || this.lost) {
      return null;
    }
    if (!this.source) {
      this.source = new web.ReadableStream<Uint8Array>({
        start: controller => {
          this.controller = controller;
        },
        cancel: () => this.endRead()
      });
    }
    return this.source;
  }

  get writable(): WritableStream<Uint8Array> | null {
    const options = this.options;
    if (!options || this.lost) {
      return null;
    }
    if (!this.sink) {
      this.sink = new web.WritableStream<Uint8Array>({
        write: chunk => {
          if (this.writeError) {
            throw this.writeError;
          }
          if (this.lost) {
            throw new DOMException('The device has been lost.', 'NetworkError');
          }
          const data = Array.from(chunk);
          const transmit = (): void => {
            this.calls.push({
              call: 'write',
              baudRate: options.baudRate,
              data
            });
            if (this.echo) {
              this.receive(data);
            }
          };
          if (!this.transmitDelay) {
            transmit();
            return;
          }
          const discards = this.discards;
          this.transmitted = this.transmitted
            .then(() => wait(this.transmitDelay))
            .then(() => {
              if (discards === this.discards) {
                transmit();
              }
            });
        },
        // The flush of the specification: it ends when every chunk is transmitted,
        // and the port then has no writable stream until it is asked for one.
        close: () =>
          this.transmitted.then(() => {
            this.sink = null;
          })
      });
    }
    return this.sink;
  }

  getInfo(): SerialPortInfo {
    return this.info;
  }

  async open(options: SerialOptions): Promise<void> {
    this.calls.push({ call: 'open', options: { ...options } });
    if (this.options) {
      throw new DOMException('The port is already open.', 'InvalidStateError');
    }
    await wait(this.delay);
    if (this.openError) {
      throw this.openError;
    }
    this.options = options;
  }

  async close(): Promise<void> {
    this.calls.push({ call: 'close' });
    if (!this.options) {
      throw new DOMException(
        'The port is already closed.',
        'InvalidStateError'
      );
    }
    if (
      (this.source && this.source.locked) ||
      (this.sink && this.sink.locked)
    ) {
      throw new TypeError('Cannot cancel a locked stream');
    }
    // close() aborts the writable stream, and the abort discards the transmit buffer.
    this.discards++;
    await wait(this.delay);
    this.options = null;
    this.sink = null;
    this.endRead();
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    if (!this.options) {
      throw new DOMException('The port is closed.', 'InvalidStateError');
    }
    // As the browser reads the dictionary: a member that is undefined is absent.
    const present = JSON.parse(JSON.stringify(signals)) as SerialOutputSignals;
    if (Object.keys(present).length === 0) {
      throw new TypeError('Signals dictionary must set at least one signal.');
    }
    this.calls.push({ call: 'setSignals', signals: present });
  }

  async forget(): Promise<void> {
    this.calls.push({ call: 'forget' });
    this.forgotten = true;
  }

  /** The device sends bytes. A closed port drops them. */
  receive(bytes: number[]): void {
    if (this.readable && this.controller) {
      this.controller.enqueue(Uint8Array.from(bytes));
    }
  }

  /**
   * End the current read stream with an error that leaves the port open, as a
   * framing, parity or overrun error does. The port gives a new stream after it.
   */
  breakRead(error: Error): void {
    if (this.controller) {
      this.controller.error(error);
    }
    this.endRead();
  }

  /** The device is gone: the read stream ends with an error and no stream follows. */
  lose(): void {
    this.breakRead(
      new DOMException('The device has been lost.', 'NetworkError')
    );
    this.lost = true;
  }

  private endRead(): void {
    this.source = null;
    this.controller = null;
  }

  private options: SerialOptions | null = null;
  private lost = false;
  private source: ReadableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private sink: WritableStream<Uint8Array> | null = null;
  /** Settles when the last chunk the port accepted is transmitted or discarded. */
  private transmitted: Promise<void> = Promise.resolve();
  /** How many times the transmit buffer was discarded; a chunk of an earlier count is not transmitted. */
  private discards = 0;
}

/** `navigator.serial`: `getPorts()`, the port dialog, `connect` and `disconnect`. */
export class SimSerial extends SimGrants<
  SimSerialPort,
  SerialPortRequestOptions
> {
  getPorts(): Promise<SimSerialPort[]> {
    return this.list();
  }

  requestPort(options?: SerialPortRequestOptions): Promise<SimSerialPort> {
    return this.ask(options);
  }
}

// --------------------------------------------------------------------- USB device

/** Endpoint 0 is the control endpoint. */
export const CONTROL_ENDPOINT = 0;
/** Endpoint 1 is a bulk loopback: what goes out on it comes back in on it. */
export const BULK_ENDPOINT = 1;
/** Endpoint 2 is an interrupt pair: out is recorded, in gives what `send()` queued. */
export const INTERRUPT_ENDPOINT = 2;

const GET_DESCRIPTOR = 6;
const DEVICE_DESCRIPTOR_TYPE = 1;
const CONFIGURATION_DESCRIPTOR_TYPE = 2;

const ENDPOINTS: USBEndpoint[] = [
  { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
  { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
  { endpointNumber: 2, direction: 'out', type: 'interrupt', packetSize: 8 },
  { endpointNumber: 2, direction: 'in', type: 'interrupt', packetSize: 8 }
];

interface IWaitingTransfer {
  resolve(result: USBInTransferResult): void;
  reject(error: Error): void;
}

/** The identity of a simulated USB device. */
export interface ISimUsbIdentity {
  vendorId: number;
  productId: number;
  serialNumber: string | null;
  productName: string | null;
  manufacturerName: string | null;
}

/**
 * A USB device with one configuration and one interface with two alternate
 * settings. It answers `GET_DESCRIPTOR`, keeps the data of a vendor control transfer
 * out for the next vendor control transfer in, and records every call.
 */
export class SimUsbDevice implements IGrantable, ISimUsbIdentity {
  readonly usbVersionMajor = 2;
  readonly usbVersionMinor = 0;
  readonly usbVersionSubminor = 0;
  readonly deviceClass = 0xff;
  readonly deviceSubclass = 0;
  readonly deviceProtocol = 0;
  readonly deviceVersionMajor = 1;
  readonly deviceVersionMinor = 2;
  readonly deviceVersionSubminor = 3;
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber: string | null;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly configurations: USBConfiguration[];
  configuration: USBConfiguration | null = null;
  opened = false;
  forgotten = false;
  /** Every call the device received, in order: the method name, then its arguments. */
  readonly calls: unknown[][] = [];
  /** The next call rejects with this error. */
  failNext: Error | null = null;
  /** Endpoint numbers that answer a transfer with status `stall` until `clearHalt`. */
  readonly stalled = new Set<number>();

  constructor(identity: Partial<ISimUsbIdentity> = {}) {
    const all: ISimUsbIdentity = {
      vendorId: 0x0d28,
      productId: 0x0204,
      serialNumber: 'SIM0001',
      productName: 'Simulated Probe',
      manufacturerName: 'Simulation',
      ...identity
    };
    this.vendorId = all.vendorId;
    this.productId = all.productId;
    this.serialNumber = all.serialNumber;
    this.productName = all.productName;
    this.manufacturerName = all.manufacturerName;
    const alternates = [0, 1].map(alternateSetting => ({
      alternateSetting,
      interfaceClass: 0xff,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      interfaceName: null,
      endpoints: ENDPOINTS
    }));
    this.iface = {
      interfaceNumber: 0,
      alternate: alternates[0],
      alternates,
      claimed: false
    };
    this.configurations = [
      {
        configurationValue: 1,
        configurationName: 'Default',
        interfaces: [this.iface]
      }
    ];
  }

  /** The 18 bytes of the device descriptor. */
  get deviceDescriptor(): number[] {
    const word = (value: number): number[] => [value & 0xff, value >> 8];
    return [
      ...[18, DEVICE_DESCRIPTOR_TYPE, 0x00, 0x02, this.deviceClass, 0, 0, 64],
      ...word(this.vendorId),
      ...word(this.productId),
      ...[0x23, 0x01, 1, 2, 3, this.configurations.length]
    ];
  }

  /** The configuration descriptor with its interface and endpoint descriptors. */
  get configurationDescriptor(): number[] {
    const endpoints = flat(
      ENDPOINTS.map(endpoint => [
        ...[7, 5],
        endpoint.endpointNumber | (endpoint.direction === 'in' ? 0x80 : 0),
        endpoint.type === 'bulk' ? 2 : 3,
        ...[endpoint.packetSize, 0, 1]
      ])
    );
    const body = flat(
      this.iface.alternates.map(alternate => [
        ...[
          9,
          4,
          0,
          alternate.alternateSetting,
          ENDPOINTS.length,
          0xff,
          0,
          0,
          0
        ],
        ...endpoints
      ])
    );
    const header = [9, CONFIGURATION_DESCRIPTOR_TYPE, 9 + body.length, 0];
    return [...header, 1, 1, 0, 0x80, 50, ...body];
  }

  async open(): Promise<void> {
    this.begin('open');
    this.opened = true;
    this.configuration = this.configurations[0];
  }

  async close(): Promise<void> {
    this.begin('close');
    this.opened = false;
    this.iface.claimed = false;
    this.abort(new DOMException('The transfer was cancelled.', 'AbortError'));
  }

  async forget(): Promise<void> {
    this.begin('forget');
    this.forgotten = true;
  }

  async reset(): Promise<void> {
    this.begin('reset');
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    this.begin('selectConfiguration', configurationValue);
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.begin('claimInterface', interfaceNumber);
    this.iface.claimed = true;
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.begin('releaseInterface', interfaceNumber);
    this.iface.claimed = false;
  }

  async selectAlternateInterface(
    interfaceNumber: number,
    alternateSetting: number
  ): Promise<void> {
    this.begin('selectAlternateInterface', interfaceNumber, alternateSetting);
    this.iface.alternate = this.iface.alternates[alternateSetting];
  }

  async clearHalt(
    direction: USBDirection,
    endpointNumber: number
  ): Promise<void> {
    this.begin('clearHalt', direction, endpointNumber);
    this.stalled.delete(endpointNumber);
  }

  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number
  ): Promise<USBInTransferResult> {
    this.begin('controlTransferIn', this.setupOf(setup), length);
    if (this.stalled.has(CONTROL_ENDPOINT)) {
      return { status: 'stall', data: undefined };
    }
    let data = this.vendorData;
    if (setup.requestType === 'standard' && setup.request === GET_DESCRIPTOR) {
      data =
        setup.value >> 8 === DEVICE_DESCRIPTOR_TYPE
          ? this.deviceDescriptor
          : this.configurationDescriptor;
    }
    return this.inResult(data.slice(0, length));
  }

  async controlTransferOut(
    setup: USBControlTransferParameters,
    data?: BufferSource
  ): Promise<USBOutTransferResult> {
    const bytes = data ? bytesOf(data) : [];
    this.begin('controlTransferOut', this.setupOf(setup), bytes);
    this.vendorData = bytes;
    return { status: 'ok', bytesWritten: bytes.length };
  }

  /** As in WebUSB: with no packet ready the transfer stays pending, with no timeout. */
  async transferIn(
    endpointNumber: number,
    length: number
  ): Promise<USBInTransferResult> {
    this.begin('transferIn', endpointNumber, length);
    if (this.stalled.has(endpointNumber)) {
      return { status: 'stall', data: undefined };
    }
    const packet = this.queue(this.packets, endpointNumber).shift();
    if (packet) {
      return this.inResult(packet);
    }
    return new Promise((resolve, reject) => {
      this.queue(this.waiting, endpointNumber).push({ resolve, reject });
    });
  }

  async transferOut(
    endpointNumber: number,
    data: BufferSource
  ): Promise<USBOutTransferResult> {
    const bytes = bytesOf(data);
    this.begin('transferOut', endpointNumber, bytes);
    if (this.stalled.has(endpointNumber)) {
      return { status: 'stall', bytesWritten: 0 };
    }
    if (endpointNumber === BULK_ENDPOINT) {
      this.send(BULK_ENDPOINT, bytes);
    }
    return { status: 'ok', bytesWritten: bytes.length };
  }

  /** The device sends one packet on an IN endpoint. */
  send(endpointNumber: number, bytes: number[]): void {
    const waiting = this.queue(this.waiting, endpointNumber).shift();
    if (waiting) {
      waiting.resolve(this.inResult(bytes));
    } else {
      this.queue(this.packets, endpointNumber).push(bytes);
    }
  }

  /** The device is gone: every pending transfer rejects. */
  lose(): void {
    this.opened = false;
    this.abort(
      new DOMException('The device was disconnected.', 'NetworkError')
    );
  }

  /** The calls with this method name, each as its arguments. */
  callsOf(method: string): unknown[][] {
    return this.calls.filter(c => c[0] === method).map(c => c.slice(1));
  }

  /** Record a call, then reject it when the test asked for an error or the device is closed. */
  private begin(method: string, ...args: unknown[]): void {
    this.calls.push([method, ...args]);
    const error = this.failNext;
    if (error) {
      this.failNext = null;
      throw error;
    }
    if (!this.opened && method !== 'open' && method !== 'forget') {
      throw new DOMException(
        'The device must be opened first.',
        'InvalidStateError'
      );
    }
  }

  private abort(error: Error): void {
    for (const waiting of this.waiting.values()) {
      waiting.splice(0).forEach(transfer => transfer.reject(error));
    }
  }

  private queue<T>(queues: Map<number, T[]>, endpointNumber: number): T[] {
    const queue = queues.get(endpointNumber) || [];
    queues.set(endpointNumber, queue);
    return queue;
  }

  /** The five members the browser reads from a setup dictionary. */
  private setupOf(
    setup: USBControlTransferParameters
  ): USBControlTransferParameters {
    const { requestType, recipient, request, value, index } = setup;
    return { requestType, recipient, request, value, index };
  }

  private inResult(bytes: number[]): USBInTransferResult {
    return { status: 'ok', data: new DataView(Uint8Array.from(bytes).buffer) };
  }

  private readonly iface: {
    interfaceNumber: number;
    alternate: USBAlternateInterface;
    alternates: USBAlternateInterface[];
    claimed: boolean;
  };
  private vendorData: number[] = [];
  private readonly packets = new Map<number, number[][]>();
  private readonly waiting = new Map<number, IWaitingTransfer[]>();
}

/** `navigator.usb`: `getDevices()`, the device dialog, `connect` and `disconnect`. */
export class SimUsb extends SimGrants<SimUsbDevice, USBDeviceRequestOptions> {
  getDevices(): Promise<SimUsbDevice[]> {
    return this.list();
  }

  requestDevice(options?: USBDeviceRequestOptions): Promise<SimUsbDevice> {
    return this.ask(options);
  }
}

// --------------------------------------------------------- WebSocket and its server

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** The tab end of one simulated WebSocket connection. */
export class SimSocket {
  binaryType = '';
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    private readonly server: SimServer
  ) {
    // The real constructor returns before the connection opens. A promise and not a
    // timer: a fake timer of 0 ms that is set while the time advances runs 1 ms late.
    void Promise.resolve().then(() => this.server.accept(this));
  }

  send(data: string | ArrayBufferView): void {
    if (this.readyState === OPEN) {
      this.server.receive(typeof data === 'string' ? data : bytesOf(data));
    }
  }

  close(): void {
    this.end();
  }

  /** Open or close the connection from the server end. */
  begin(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  end(): void {
    if (this.readyState !== CLOSED) {
      this.readyState = CLOSED;
      this.onclose?.();
    }
  }

  /** Deliver a message from the server in a later turn, as a network does. */
  deliver(data: string | ArrayBuffer): void {
    void Promise.resolve().then(() => {
      if (this.readyState === OPEN) {
        this.onmessage?.({ data });
      }
    });
  }
}

/** A binary frame the tab sent: bytes a port received. */
export interface IDataFrame {
  sid: number;
  data: number[];
}

/** A server command before the server numbers it. */
type Unnumbered<T> = T extends unknown ? Omit<T, 'seq'> : never;

/**
 * The server end of the WebSocket, as docs/design.md describes it: it welcomes a tab,
 * answers claims with a name, a sid and settings, keeps the device table and sends it
 * on every change, answers pings, and numbers its commands.
 *
 * @example
 * const seq = server.command({ type: 'serial-action', name, action: 'pulse-dtr' });
 * await jest.advanceTimersByTimeAsync(100);
 * expect(server.ack(seq)).toMatchObject({ ok: true });
 */
export class SimServer {
  /** Every connection the tab made, in order. */
  readonly sockets: SimSocket[] = [];
  /** Every text message the tab sent, in order. */
  readonly received: TabMessage[] = [];
  /** Every binary frame the tab sent, in order. */
  readonly frames: IDataFrame[] = [];
  /** While false, a new connection is closed and not opened. */
  accepting = true;
  /** The settings a granted serial claim is answered with. */
  settings: ISerialSettings = {
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1
  };
  /** Keys another tab holds, with that tab's id. A claim on one is refused. */
  readonly heldBy = new Map<string, string>();
  /** Keys whose claim is refused with no holder named, as when the server cannot make the device. */
  readonly refused = new Set<string>();
  /** While false, a claim gets no answer. */
  answerClaims = true;
  /** Milliseconds between a ping and its pong. */
  pongDelay = 0;
  /** The profiles sent with `welcome`. */
  readonly profiles: IProfile[] = [
    { id: 'monitor', label: 'Monitor', ...this.settings, onOpen: 'none' }
  ];
  /** The device table, sent to the tab on every change. */
  readonly table: IDeviceTable = { serial: [], usb: [] };
  /** The pending device requests; `push()` sends them. */
  readonly pending: IDeviceRequest[] = [];

  /** The constructor that stands for `WebSocket` in the worker scope. */
  get WebSocket(): new (url: string) => WebSocket {
    const connect = (url: string): SimSocket => {
      const socket = new SimSocket(url, this);
      this.sockets.push(socket);
      return socket;
    };
    // A constructor that returns an object gives that object to `new`.
    return function (url: string) {
      return connect(url);
    } as unknown as new (url: string) => WebSocket;
  }

  /** The newest connection. */
  get socket(): SimSocket {
    return this.sockets[this.sockets.length - 1];
  }

  /** The text messages of one type that the tab sent, in order. */
  sent<K extends TabMessage['type']>(
    type: K
  ): Array<Extract<TabMessage, { type: K }>> {
    return this.received.filter(
      (message): message is Extract<TabMessage, { type: K }> =>
        message.type === type
    );
  }

  /** The tab's answer to command `seq`, or undefined while there is none. */
  ack(seq: number): IAckMessage | undefined {
    return this.sent('ack').find(ack => ack.seq === seq);
  }

  /** Send one message to the tab. */
  send(message: ServerMessage): void {
    this.socket.deliver(JSON.stringify(message));
  }

  /** Send a command with the next sequence number and return that number. */
  command(command: Unnumbered<SerialCommand | UsbCommand>): number {
    const seq = ++this.seq;
    this.send({ ...command, seq } as ServerMessage);
    return seq;
  }

  /** Send bytes for the port with this sid as one binary frame. */
  sendData(sid: number, bytes: number[]): void {
    this.socket.deliver(
      Uint8Array.from([0x01, sid >> 8, sid & 0xff, ...bytes]).buffer
    );
  }

  /** Send the device table and the pending requests as they are now. */
  push(): void {
    this.send({ type: 'devices', ...this.table });
    this.send({ type: 'requests', pending: [...this.pending] });
  }

  /** Close the current connection from the server end. */
  drop(): void {
    this.socket.end();
  }

  /** Called by a new socket: open it, or refuse it. */
  accept(socket: SimSocket): void {
    if (this.accepting) {
      socket.begin();
    } else {
      socket.end();
    }
  }

  /** Called by the socket with what the tab sent. */
  receive(data: string | number[]): void {
    if (typeof data !== 'string') {
      this.frames.push({ sid: (data[1] << 8) | data[2], data: data.slice(3) });
      return;
    }
    const message = JSON.parse(data) as TabMessage;
    this.received.push(message);
    switch (message.type) {
      case 'hello':
        this.tabId = message.tabId;
        this.detachAll();
        this.send({
          type: 'welcome',
          tabId: message.tabId,
          profiles: this.profiles,
          deviceDir: DEVICE_DIR
        });
        this.push();
        return;
      case 'claim':
        if (this.answerClaims) {
          this.claim(message.kind, message.key, message.info);
        }
        return;
      case 'release':
        this.release(message.name, message.reason === 'forget');
        return;
      case 'serial-state': {
        const record = this.table.serial.find(r => r.name === message.name);
        if (record && message.settings) {
          record.portState = message.state;
          record.settings = message.settings;
          record.signals = message.signals;
          record.error = message.error || null;
          this.push();
        }
        return;
      }
      case 'usb-descriptors': {
        const record = this.table.usb.find(r => r.name === message.name);
        if (record) {
          record.opened = message.descriptors.opened;
          this.push();
        }
        return;
      }
      case 'stats': {
        const record = this.records().find(r => r.name === message.name);
        if (record) {
          record.rx = message.rx;
          record.tx = message.tx;
          this.push();
        }
        return;
      }
      case 'request-result': {
        const index = this.pending.findIndex(r => r.id === message.id);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this.push();
        }
        return;
      }
      case 'ping': {
        const pong = (): void => this.send({ type: 'pong', t: message.t });
        if (this.pongDelay) {
          setTimeout(pong, this.pongDelay);
        } else {
          pong();
        }
        return;
      }
    }
  }

  private records(): Array<ISerialRecord | IUsbRecord> {
    return [...this.table.serial, ...this.table.usb];
  }

  /** A tab that connects again held nothing while it was away. */
  private detachAll(): void {
    for (const record of this.records()) {
      if (record.tab === this.tabId) {
        record.state = 'detached';
        record.tab = null;
      }
    }
  }

  /** The name of a key: kept once given, numbered from the second of a kind. */
  private nameOf(key: string, base: string): string {
    let name = this.names.get(key);
    if (!name) {
      const taken = new Set(this.names.values());
      let n = 1;
      const candidate = (): string => (n === 1 ? base : `${base}-${n}`);
      while (taken.has(candidate())) {
        n++;
      }
      name = candidate();
      this.names.set(key, name);
    }
    return name;
  }

  private claim(
    kind: IClaimMessage['kind'],
    key: string,
    info: IClaimMessage['info']
  ): void {
    const heldBy = this.heldBy.get(key);
    if (heldBy || this.refused.has(key)) {
      this.send({ type: 'claimed', key, ok: false, heldBy });
      return;
    }
    const owner = { state: 'attached' as const, tab: this.tabId };
    const counters = { rx: 0, tx: 0, error: null };
    if (kind === 'serial') {
      const { usbVendorId, usbProductId } = info as ISerialClaimInfo;
      const ids = usbVendorId !== undefined && usbProductId !== undefined;
      const name = this.nameOf(
        key,
        ids ? `tty-${hex(usbVendorId)}-${hex(usbProductId)}` : 'tty-port'
      );
      const record = this.table.serial.find(r => r.name === name);
      if (record) {
        Object.assign(record, owner);
      } else {
        this.sids.set(name, this.sids.size + 1);
        this.table.serial.push({
          name,
          path: `${DEVICE_DIR}/${name}`,
          ...owner,
          ...counters,
          portState: 'closed',
          holder: null,
          settings: this.settings,
          profile: 'monitor',
          overrides: {},
          signals: {},
          vendorId: usbVendorId ?? null,
          productId: usbProductId ?? null
        });
      }
      this.send({
        type: 'claimed',
        key,
        ok: true,
        name,
        sid: this.sids.get(name),
        settings: this.settings,
        profile: 'monitor'
      });
    } else {
      const usb = info as IUsbClaimInfo;
      const name = this.nameOf(
        key,
        `usb-${hex(usb.vendorId)}-${hex(usb.productId)}`
      );
      const record = this.table.usb.find(r => r.name === name);
      if (record) {
        Object.assign(record, owner);
      } else {
        this.table.usb.push({
          name,
          ...owner,
          ...counters,
          vendorId: usb.vendorId,
          productId: usb.productId,
          productName: usb.productName ?? null,
          manufacturerName: usb.manufacturerName ?? null,
          serialNumber: usb.serialNumber ?? null,
          opened: false,
          holder: null
        });
      }
      this.send({ type: 'claimed', key, ok: true, name });
    }
    this.push();
  }

  private release(name: string, forget: boolean): void {
    for (const list of [this.table.serial, this.table.usb]) {
      const index = list.findIndex(record => record.name === name);
      if (index < 0) {
        continue;
      }
      if (forget) {
        list.splice(index, 1);
      } else {
        Object.assign(list[index], { state: 'detached', tab: null });
      }
    }
    this.push();
  }

  private seq = 0;
  private tabId = '';
  private readonly names = new Map<string, string>();
  private readonly sids = new Map<string, number>();
}

// -------------------------------------------------------------------- worker scope

/** What the page holds of a worker: the object `createWorker()` returns in a browser. */
export interface ISimWorker {
  onmessage: ((event: { data: WorkerToPage }) => void) | null;
  postMessage(message: PageToWorker): void;
  terminate(): void;
}

/**
 * The global scope of the dedicated worker, with the page at its other end.
 *
 * @example
 * const scope = new SimScope(server, new SimSerial(port));
 * workerMain(scope);
 * scope.post({ type: 'start', url: 'ws://lab/ws' });
 */
export class SimScope implements IWorkerScope {
  readonly navigator: IWorkerScope['navigator'];
  readonly WebSocket: IWorkerScope['WebSocket'];
  readonly crypto = { randomUUID: (): string => this.tabId };
  // The timers and the clock are read at call time, so Jest's fake ones are used.
  readonly performance = { now: (): number => performance.now() };
  /** Every message the worker posted to the page, in order. */
  readonly posted: WorkerToPage[] = [];
  /** Set by `workerMain`. */
  onmessage: IWorkerScope['onmessage'] = null;
  /** True after the page terminated the worker. */
  terminated = false;
  /** The page end of the worker. */
  readonly page: ISimWorker = {
    onmessage: null,
    postMessage: message => this.post(message),
    terminate: () => {
      this.terminated = true;
    }
  };

  constructor(
    server: SimServer,
    serial?: SimSerial,
    usb?: SimUsb,
    private readonly tabId = 'tab-1'
  ) {
    this.WebSocket = server.WebSocket;
    this.navigator = {
      serial: serial as unknown as Serial | undefined,
      usb: usb as unknown as USB | undefined
    };
  }

  setTimeout(handler: () => void, ms: number): number {
    return setTimeout(handler, ms) as unknown as number;
  }

  clearTimeout(id: number): void {
    clearTimeout(id);
  }

  setInterval(handler: () => void, ms: number): number {
    return setInterval(handler, ms) as unknown as number;
  }

  clearInterval(id: number): void {
    clearInterval(id);
  }

  atob(data: string): string {
    return atob(data);
  }

  btoa(data: string): string {
    return btoa(data);
  }

  postMessage(message: WorkerToPage): void {
    this.posted.push(message);
    // A terminated worker delivers nothing more to the page.
    if (!this.terminated) {
      this.page.onmessage?.({ data: message });
    }
  }

  /** Deliver a message from the page to the worker. */
  post(message: PageToWorker): void {
    this.onmessage?.({ data: message });
  }

  /** The messages of one type that the worker posted to the page, in order. */
  postedOf<K extends WorkerToPage['type']>(
    type: K
  ): Array<Extract<WorkerToPage, { type: K }>> {
    return this.posted.filter(
      (message): message is Extract<WorkerToPage, { type: K }> =>
        message.type === type
    );
  }
}
