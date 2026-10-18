/**
 * Wire types of the device bridge.
 *
 * Three groups: the records and settings of docs/design.md, the WebSocket messages
 * between the worker and the server, and the messages between the page and the worker.
 * The file holds types only. The worker function uses them and stays self-contained,
 * because types leave no code behind.
 */

// ---------------------------------------------------------------- settings and records

export type DeviceKind = 'serial' | 'usb';

export type SerialParity = 'none' | 'even' | 'odd';

/** What the worker does on a port when the server asks for an action. */
export type SerialAction =
  'none' | 'pulse-dtr' | 'pulse-rts' | 'esp-bootloader' | 'touch-1200';

/** State of a serial port inside the worker. */
export type PortState = 'closed' | 'opening' | 'open' | 'error';

/** Whether a tab holds the device now. */
export type DeviceState = 'attached' | 'detached';

export type ReleaseReason = 'detach' | 'forget' | 'removed';

/** The settings a serial port is opened with. */
export interface ISerialSettings {
  baudRate: number;
  dataBits: 7 | 8;
  parity: SerialParity;
  stopBits: 1 | 2;
}

/**
 * Control lines of a serial port. A line is present only after the bridge set it since
 * the port was opened; the level before that is the choice of the browser and the driver.
 */
export interface ISerialSignals {
  dtr?: boolean;
  rts?: boolean;
  brk?: boolean;
}

/** The five serial settings a port uses: the four settings and the action on open. */
export interface ISerialConfig extends ISerialSettings {
  onOpen: SerialAction;
}

/** The default serial settings of the lab: what a serial port gets when the server has no record. */
export type ISerialDefaults = ISerialConfig;

/** A named serial settings config: a system config or one the user saved. */
export interface ISettingsConfig extends ISerialConfig {
  id: string;
  name: string;
  system: boolean;
}

/** Body of `PUT serial/<name>/settings`: a saved config, or single fields. */
export interface ISerialSettingsChange extends Partial<ISerialConfig> {
  config?: string;
}

/** Name and message of a browser error, unchanged. */
export interface IErrorInfo {
  name: string;
  message: string;
}

/** The container program that holds a virtual serial device. */
export interface IHolder {
  pid: number;
  name: string;
}

/** One serial device in the server's table. */
export interface ISerialRecord {
  name: string;
  path: string;
  state: DeviceState;
  portState: PortState;
  tab: string | null;
  holder: IHolder | null;
  settings: ISerialSettings;
  configured: ISerialConfig;
  config: string | null;
  configName: string | null;
  signals: ISerialSignals;
  rx: number;
  tx: number;
  vendorId: number | null;
  productId: number | null;
  error: string | null;
}

/** The container program that opened a USB device. The server knows its name only. */
export interface IUsbHolder {
  name: string;
}

/** One USB device in the server's table. */
export interface IUsbRecord {
  name: string;
  state: DeviceState;
  tab: string | null;
  vendorId: number;
  productId: number;
  productName: string | null;
  manufacturerName: string | null;
  serialNumber: string | null;
  opened: boolean;
  holder: IUsbHolder | null;
  rx: number;
  tx: number;
  error: string | null;
}

/** The whole device table. */
export interface IDeviceTable {
  serial: ISerialRecord[];
  usb: IUsbRecord[];
}

/** A container program's pending request for a device that is not granted yet. */
export interface IDeviceRequest {
  id: string;
  kind: DeviceKind;
  vendorId?: number;
  productId?: number;
  reason: string;
  program: string;
}

/** One process that `jupyterlab-device run` started. `pid` identifies the run. */
export interface IRunRecord {
  pid: number;
  /** The base name of the first word of the command. */
  program: string;
  /** The words of the command joined with one space, cut after 200 characters. */
  command: string;
  /** The `--device` of the run, or null. */
  device: string | null;
}

// ------------------------------------------------------------------------ USB payloads

/** Setup packet of a control transfer, in WebUSB's own names. */
export interface IUsbControlSetup {
  requestType: USBRequestType;
  recipient: USBRecipient;
  request: number;
  value: number;
  index: number;
}

/**
 * Operation and arguments of one `usb` command. The operation names are those of the
 * REST route `POST usb/<name>/<op>`; the argument names are WebUSB's own parameter names.
 * Binary data is base64. `timeout` is in ms: when it ends the worker answers
 * `TimeoutError` and keeps the transfer for the next `transfer-in` on that endpoint.
 */
export type UsbOperation =
  | { op: 'open' | 'close' | 'reset'; args?: Record<string, never> }
  | { op: 'select-configuration'; args: { configurationValue: number } }
  | {
      op: 'claim-interface' | 'release-interface';
      args: { interfaceNumber: number };
    }
  | {
      op: 'select-alternate';
      args: { interfaceNumber: number; alternateSetting: number };
    }
  | { op: 'control-in'; args: IUsbControlSetup & { length: number } }
  | { op: 'control-out'; args: IUsbControlSetup & { data?: string } }
  | {
      op: 'transfer-in';
      args: { endpointNumber: number; length: number; timeout?: number };
    }
  | { op: 'transfer-out'; args: { endpointNumber: number; data: string } }
  | {
      op: 'clear-halt';
      args: { direction: USBDirection; endpointNumber: number };
    };

export type UsbOp = UsbOperation['op'];

/**
 * Result of a USB transfer: `status` and `data` (base64) for a transfer in, `status`
 * and `bytesWritten` for a transfer out. Every other operation has no result.
 */
export interface IUsbResult {
  status: USBTransferStatus;
  data?: string;
  bytesWritten?: number;
}

/** One endpoint, as WebUSB parsed it. */
export interface IUsbEndpointDescriptor {
  endpointNumber: number;
  direction: USBDirection;
  type: USBEndpointType;
  packetSize: number;
}

/** One alternate setting of an interface, as WebUSB parsed it. */
export interface IUsbAlternateDescriptor {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceName: string | null;
  endpoints: IUsbEndpointDescriptor[];
}

/** One interface; `alternateSetting` is the selected one. */
export interface IUsbInterfaceDescriptor {
  interfaceNumber: number;
  claimed: boolean;
  alternateSetting: number;
  alternates: IUsbAlternateDescriptor[];
}

/** One configuration, as WebUSB parsed it. */
export interface IUsbConfigurationDescriptor {
  configurationValue: number;
  configurationName: string | null;
  interfaces: IUsbInterfaceDescriptor[];
}

/** The device and configuration descriptors as the device sent them, base64. */
export interface IUsbRawDescriptors {
  device: string;
  configurations: string[];
}

/**
 * Descriptors of a USB device. The fields carry WebUSB's own names and values.
 * `configurationValue` is the selected configuration. `raw` is present once the device
 * is open; `rawError` says why it is absent on an open device.
 */
export interface IUsbDescriptors {
  usbVersionMajor: number;
  usbVersionMinor: number;
  usbVersionSubminor: number;
  deviceClass: number;
  deviceSubclass: number;
  deviceProtocol: number;
  vendorId: number;
  productId: number;
  deviceVersionMajor: number;
  deviceVersionMinor: number;
  deviceVersionSubminor: number;
  manufacturerName: string | null;
  productName: string | null;
  serialNumber: string | null;
  configurationValue: number | null;
  configurations: IUsbConfigurationDescriptor[];
  opened: boolean;
  raw?: IUsbRawDescriptors;
  rawError?: IErrorInfo;
}

// ------------------------------------------------------------ WebSocket: tab to server

/** First message of a connection: the tab's id and the interfaces its browser has. */
export interface IHelloMessage {
  type: 'hello';
  tabId: string;
  serial: boolean;
  usb: boolean;
}

/** `info` of a serial claim. */
export interface ISerialClaimInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

/** `info` of a USB claim. */
export interface IUsbClaimInfo {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
}

/**
 * Ask to own a device. `defaults` is in the claim of a serial port when the page gave
 * the worker the default serial settings; the claim of a USB device has none.
 */
export interface IClaimMessage {
  type: 'claim';
  kind: DeviceKind;
  key: string;
  info: ISerialClaimInfo | IUsbClaimInfo;
  defaults?: ISerialDefaults;
}

/** The port's state changed. `error` is the browser's reason text. */
export interface ISerialStateMessage {
  type: 'serial-state';
  name: string;
  state: PortState;
  settings: ISerialSettings | null;
  signals: ISerialSignals;
  error?: string;
}

/** Sent after a claim is granted and again after `open`. */
export interface IUsbDescriptorsMessage {
  type: 'usb-descriptors';
  name: string;
  descriptors: IUsbDescriptors;
}

/** Byte counters of one device. */
export interface IStatsMessage {
  type: 'stats';
  name: string;
  rx: number;
  tx: number;
}

/** The tab gave the device up. */
export interface IReleaseMessage {
  type: 'release';
  name: string;
  reason: ReleaseReason;
}

/** Answer to a server command. */
export interface IAckMessage {
  type: 'ack';
  seq: number;
  ok: boolean;
  result?: IUsbResult;
  error?: IErrorInfo;
}

/** Outcome of a device request the user acted on. */
export interface IRequestResultMessage {
  type: 'request-result';
  id: string;
  ok: boolean;
  name?: string;
  error?: IErrorInfo;
}

/** Round-trip probe. */
export interface IPingMessage {
  type: 'ping';
  t: number;
}

export type TabMessage =
  | IHelloMessage
  | IClaimMessage
  | ISerialStateMessage
  | IUsbDescriptorsMessage
  | IStatsMessage
  | IReleaseMessage
  | IAckMessage
  | IRequestResultMessage
  | IPingMessage;

// ------------------------------------------------------------ WebSocket: server to tab

/** Answer to `hello`. */
export interface IWelcomeMessage {
  type: 'welcome';
  tabId: string;
  configs: ISettingsConfig[];
  deviceDir: string;
}

/** Answer to `claim`. On `ok` the worker opens a serial port with `settings`. */
export interface IClaimedMessage {
  type: 'claimed';
  key: string;
  ok: boolean;
  name?: string;
  sid?: number;
  settings?: ISerialSettings;
  profile?: string;
  heldBy?: string;
}

/** The whole device table, on every change. */
export interface IDevicesMessage extends IDeviceTable {
  type: 'devices';
}

/** The pending device requests, on every change. */
export interface IRequestsMessage {
  type: 'requests';
  pending: IDeviceRequest[];
}

/** Every live run, after `welcome` and on every change. */
export interface IRunsMessage {
  type: 'runs';
  running: IRunRecord[];
}

/** Reopen the port with these settings. */
export interface ISerialConfigureCommand {
  type: 'serial-configure';
  seq: number;
  name: string;
  settings: ISerialSettings;
}

/** Set control lines. */
export interface ISerialSignalsCommand extends ISerialSignals {
  type: 'serial-signals';
  seq: number;
  name: string;
}

/** Run one action. */
export interface ISerialActionCommand {
  type: 'serial-action';
  seq: number;
  name: string;
  action: SerialAction;
}

/** Write bytes that did not come from the pty; `data` is base64. */
export interface ISerialWriteCommand {
  type: 'serial-write';
  seq: number;
  name: string;
  data: string;
}

export type SerialCommand =
  | ISerialConfigureCommand
  | ISerialSignalsCommand
  | ISerialActionCommand
  | ISerialWriteCommand;

/** One USB operation. */
export type UsbCommand = {
  type: 'usb';
  seq: number;
  name: string;
} & UsbOperation;

/** Echo of `ping`. */
export interface IPongMessage {
  type: 'pong';
  t: number;
}

export type ServerMessage =
  | IWelcomeMessage
  | IClaimedMessage
  | IDevicesMessage
  | IRequestsMessage
  | IRunsMessage
  | SerialCommand
  | UsbCommand
  | IPongMessage;

// ------------------------------------------------------------------- page and worker

/** A device the browser lists as granted to this tab, as the worker tracks it. */
export interface IGrant {
  kind: DeviceKind;
  key: string;
  /** The server's name for the device; null until a claim answered with one. */
  name: string | null;
  /** Whether this tab holds the device now. */
  attached: boolean;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

/** The device the user picked in a grant dialog, by the ids the browser shows. */
export interface IGrantedDevice {
  kind: DeviceKind;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

/** Page to worker: connect the WebSocket at this URL. Sent once. */
export interface IStartMessage {
  type: 'start';
  url: string;
}

/**
 * Page to worker: the default serial settings, for the claim of every serial port from
 * now on. Sent before `start` and again when the settings of the lab change.
 */
export interface IDefaultsMessage {
  type: 'defaults';
  serial: ISerialDefaults;
}

/** Page to worker: a grant dialog ended with a device; list the granted devices again. With `request`, answer that device request with the picked device. */
export interface IRescanMessage {
  type: 'rescan';
  request?: IGrantedDevice & { id: string };
}

/** Page to worker: claim the granted devices with these keys. */
export interface IAttachMessage {
  type: 'attach';
  keys: string[];
}

/** Page to worker: close and release the devices with these keys; the grants stay. */
export interface IDetachMessage {
  type: 'detach';
  keys: string[];
}

/** Page to worker: revoke the grants with these keys and release device `name` with reason `forget`. */
export interface IForgetMessage {
  type: 'forget';
  name: string;
  keys: string[];
}

/** The page also sends `request-result` when a grant dialog of a device request fails; the worker passes it to the server unchanged. */
export type PageToWorker =
  | IStartMessage
  | IDefaultsMessage
  | IRescanMessage
  | IAttachMessage
  | IDetachMessage
  | IForgetMessage
  | IRequestResultMessage;

/** Worker to page: the round trip of the last ping, in ms. */
export interface IRoundTripMessage {
  type: 'rtt';
  ms: number;
}

/** Worker to page: the devices the browser lists as granted, after every change of the list or of a claim. */
export interface IGrantsMessage {
  type: 'grants';
  grants: IGrant[];
}

/** Worker to page: the WebSocket closed; the worker reconnects by itself. */
export interface IClosedMessage {
  type: 'closed';
}

/** One device of this tab that moved bytes in the last look of the worker. */
export interface IDeviceActivity {
  name: string;
  /** Bytes came from the device. */
  rx: boolean;
  /** Bytes went to the device. */
  tx: boolean;
}

/**
 * Worker to page: the devices of this tab that moved bytes in the last 50 ms. The
 * worker looks at its byte counters every 50 ms while it holds an open device, and
 * posts the message only when a counter grew.
 */
export interface IActivityMessage {
  type: 'activity';
  devices: IDeviceActivity[];
}

/** The worker also passes the server's `welcome`, `devices`, `requests` and `runs` to the page unchanged. */
export type WorkerToPage =
  | IWelcomeMessage
  | IDevicesMessage
  | IRequestsMessage
  | IRunsMessage
  | IActivityMessage
  | IRoundTripMessage
  | IGrantsMessage
  | IClosedMessage;
