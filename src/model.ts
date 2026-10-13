/**
 * The model of the device bridge: the one object the user interface talks to.
 *
 * It starts the dedicated worker, keeps what the worker reports (the device table,
 * the pending device requests, the runs, the round trip), and opens the browser's
 * grant dialogs, which exist only in the page.
 */

import { ServerConnection } from '@jupyterlab/services';

import { IDisposable } from '@lumino/disposable';

import { ISignal, Signal } from '@lumino/signaling';

import type {
  DeviceKind,
  IDeviceActivity,
  IDeviceRequest,
  IDeviceTable,
  IErrorInfo,
  IGrant,
  IGrantedDevice,
  IProfile,
  IProfileChange,
  IRunRecord,
  ISerialDefaults,
  PageToWorker,
  WorkerToPage
} from './protocol';
import { deviceBridgeWsUrl, requestAPI } from './request';
import { createWorker } from './worker';

/**
 * Why a grant dialog gave no device.
 *
 * - `unsupported`: the browser has no such device interface in this page
 * - `gesture`: the browser refused to open the dialog outside a user gesture
 * - `cancelled`: the user closed the dialog without choosing a device
 * - `failed`: any other error of the browser
 */
export type GrantFailure = 'unsupported' | 'gesture' | 'cancelled' | 'failed';

/** A grant dialog that gave no device. `message` is the browser's own text. */
export class GrantError extends Error {
  /**
   * @param reason Why there is no device
   * @param browser The browser's error name and message, unchanged
   */
  constructor(
    readonly reason: GrantFailure,
    readonly browser: IErrorInfo
  ) {
    super(browser.message);
    this.name = 'GrantError';
  }
}

/** Which device interfaces the browser has in this page. */
export interface IInterfaces {
  serial: boolean;
  usb: boolean;
}

/** The browser's error names that say why a dialog gave no device. */
const GRANT_FAILURES: { [name: string]: GrantFailure } = {
  SecurityError: 'gesture',
  NotFoundError: 'cancelled'
};

const ABSENT_MESSAGE =
  'The browser offers no device interface here. Open the lab over HTTPS or at localhost, in Chrome or Edge.';

const EMPTY_TABLE: IDeviceTable = { serial: [], usb: [] };

/**
 * The state of the device bridge in this lab tab, and the actions on it.
 *
 * @example
 * const model = new DeviceBridgeModel(app.serviceManager.serverSettings);
 * model.devicesChanged.connect(() => render(model.devices));
 * button.onclick = () => model.connectSerial().catch(showGrantError);
 */
export class DeviceBridgeModel implements IDisposable {
  /**
   * Start the worker and connect it to the server.
   *
   * @param serverSettings The server settings of the lab
   * @param serialDefaults The default serial settings of the lab. Without them a
   * serial port is added with the settings of the server's default profile
   */
  constructor(
    serverSettings: ServerConnection.ISettings,
    serialDefaults?: ISerialDefaults
  ) {
    this._serverSettings = serverSettings;
    this._worker = createWorker();
    this._worker.onmessage = (event: MessageEvent<WorkerToPage>) =>
      this._onMessage(event.data);
    // Before `start`: the worker claims the ports granted earlier when it connects.
    if (serialDefaults) {
      this.setSerialDefaults(serialDefaults);
    }
    this._post({ type: 'start', url: deviceBridgeWsUrl(serverSettings) });
  }

  /** Which device interfaces the browser has. Fixed for the life of the page, so it has no signal. */
  readonly interfaces: IInterfaces = {
    serial: 'serial' in navigator,
    usb: 'usb' in navigator
  };

  /** The device table of the server. Empty while the WebSocket is closed. */
  get devices(): IDeviceTable {
    return this._devices;
  }

  /** The id of this tab; null until the server answered the first time. */
  get tabId(): string | null {
    return this._tabId;
  }

  /** The built-in profiles of the server; set together with `tabId`. */
  get profiles(): IProfile[] {
    return this._profiles;
  }

  /** The device requests of container programs that wait for the user. */
  get requests(): IDeviceRequest[] {
    return this._requests;
  }

  /** The live runs, as the server listed them last. Empty while the WebSocket is closed. */
  get runs(): IRunRecord[] {
    return this._runs;
  }

  /** The last round trip between browser and server in ms; null while the WebSocket is closed. */
  get roundTrip(): number | null {
    return this._roundTrip;
  }

  /** Emitted when the device table changes, and when a grant of this tab changes. */
  get devicesChanged(): ISignal<this, IDeviceTable> {
    return this._devicesChanged;
  }

  /** Emitted when the server answered and `tabId` and `profiles` are set. */
  get tabIdChanged(): ISignal<this, string | null> {
    return this._tabIdChanged;
  }

  get requestsChanged(): ISignal<this, IDeviceRequest[]> {
    return this._requestsChanged;
  }

  get runsChanged(): ISignal<this, IRunRecord[]> {
    return this._runsChanged;
  }

  get roundTripChanged(): ISignal<this, number | null> {
    return this._roundTripChanged;
  }

  /**
   * Emitted for each 50 ms period in which devices of this tab moved bytes, with those
   * devices and their directions. The model keeps nothing of it.
   */
  get activity(): ISignal<this, IDeviceActivity[]> {
    return this._activity;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Whether this tab has a grant for a device in the table. A detached device with a
   * grant can be attached from this tab.
   *
   * @param name The device name
   */
  hasGrant(name: string): boolean {
    return this._grantsFor(name).length > 0;
  }

  /**
   * Set the serial settings and the action on open that a serial port gets when it
   * is added. A port the server has a record of keeps its values.
   *
   * @param serial The default serial settings of the lab
   */
  setSerialDefaults(serial: ISerialDefaults): void {
    this._post({ type: 'defaults', serial });
  }

  /**
   * Open the browser's serial port dialog and attach the port the user picks.
   * Call it from a click or a command, because the browser wants a user gesture.
   *
   * @throws GrantError when the dialog gives no port
   */
  async connectSerial(): Promise<void> {
    await this._requestPort();
    this._post({ type: 'rescan' });
  }

  /**
   * Open the browser's USB device dialog and attach the device the user picks.
   * Call it from a click or a command, because the browser wants a user gesture.
   *
   * @param filters The devices the dialog offers; every device when empty
   * @throws GrantError when the dialog gives no device
   */
  async connectUsb(filters: USBDeviceFilter[] = []): Promise<void> {
    await this._requestDevice(filters);
    this._post({ type: 'rescan' });
  }

  /**
   * Attach a detached device that this tab has a grant for.
   *
   * @param name The device name
   */
  attach(name: string): void {
    this._post({ type: 'attach', keys: this._keysFor(name, false) });
  }

  /**
   * Close a device this tab holds and give it up. The grant stays.
   *
   * @param name The device name
   */
  detach(name: string): void {
    this._post({ type: 'detach', keys: this._keysFor(name, true) });
  }

  /**
   * Revoke this tab's grant for a device and remove the device from the server.
   *
   * @param name The device name
   */
  forget(name: string): void {
    const keys = this._grantsFor(name).map(grant => grant.key);
    this._post({ type: 'forget', name, keys });
  }

  /**
   * Set the profile of a serial device, or single fields of it.
   *
   * @param name The device name
   * @param change The profile id and the fields to override
   * @throws ServerConnection.ResponseError when the server refuses the change
   */
  async setProfile(name: string, change: IProfileChange): Promise<void> {
    await requestAPI<unknown>(
      `serial/${encodeURIComponent(name)}/profile`,
      this._serverSettings,
      { method: 'PUT', body: JSON.stringify(change) }
    );
  }

  /**
   * Ask the server to end the process of a run. The run stays in `runs` until the
   * server lists it no more, which is when the process has ended.
   *
   * @param pid The process id of the run
   * @throws ServerConnection.ResponseError when the server refuses, for example
   * because it knows no run with this process id
   */
  async stopRun(pid: number): Promise<void> {
    await requestAPI<unknown>(`runs/${pid}`, this._serverSettings, {
      method: 'DELETE'
    });
  }

  /**
   * Act on a pending device request: open the grant dialog with the vendor and
   * product id the program asked for, attach the device and answer the request.
   * Call it from a click, because the browser wants a user gesture.
   *
   * A dialog that gives no device answers the request as denied with the browser's
   * reason. Outside a user gesture the dialog did not open, so the request stays
   * pending.
   *
   * @param id The id of the pending request
   * @throws GrantError when the dialog gives no device
   * @throws Error when no request with this id is pending
   */
  async grantRequest(id: string): Promise<void> {
    const request = this._requests.find(pending => pending.id === id);
    if (!request) {
      throw new Error(`Device request ${id} is not pending`);
    }
    // The server may send null for an id the program did not give.
    const vendorId = request.vendorId ?? undefined;
    const productId = request.productId ?? undefined;
    const filtered = vendorId !== undefined || productId !== undefined;
    let device: IGrantedDevice;
    try {
      device =
        request.kind === 'serial'
          ? await this._requestPort(
              filtered
                ? { usbVendorId: vendorId, usbProductId: productId }
                : undefined
            )
          : await this._requestDevice(
              filtered ? [{ vendorId, productId }] : []
            );
    } catch (error) {
      const refused = error as GrantError;
      if (refused.reason !== 'gesture') {
        this._post({
          type: 'request-result',
          id,
          ok: false,
          error: refused.browser
        });
      }
      throw error;
    }
    this._post({ type: 'rescan', request: { id, ...device } });
  }

  /** Stop the worker. Its WebSocket closes, and the server detaches this tab's devices. */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._worker.terminate();
    Signal.clearData(this);
  }

  private _post(message: PageToWorker): void {
    this._worker.postMessage(message);
  }

  private _onMessage(message: WorkerToPage): void {
    switch (message.type) {
      case 'welcome':
        this._tabId = message.tabId;
        this._profiles = message.profiles;
        this._tabIdChanged.emit(this._tabId);
        return;
      case 'devices':
        this._setDevices({ serial: message.serial, usb: message.usb });
        return;
      case 'grants':
        this._grants = message.grants;
        this._devicesChanged.emit(this._devices);
        return;
      case 'requests':
        this._setRequests(message.pending);
        return;
      case 'runs':
        this._setRuns(message.running);
        return;
      case 'activity':
        this._activity.emit(message.devices);
        return;
      case 'rtt':
        this._setRoundTrip(message.ms);
        return;
      case 'closed':
        // The server detached this tab's devices, and nothing it sent before is
        // known to be true any more.
        this._setRoundTrip(null);
        this._setDevices(EMPTY_TABLE);
        this._setRequests([]);
        this._setRuns([]);
        return;
    }
  }

  private _setDevices(devices: IDeviceTable): void {
    this._devices = devices;
    this._devicesChanged.emit(devices);
  }

  private _setRequests(requests: IDeviceRequest[]): void {
    this._requests = requests;
    this._requestsChanged.emit(requests);
  }

  private _setRuns(runs: IRunRecord[]): void {
    this._runs = runs;
    this._runsChanged.emit(runs);
  }

  private _setRoundTrip(ms: number | null): void {
    this._roundTrip = ms;
    this._roundTripChanged.emit(ms);
  }

  /**
   * The grants of this tab for a device in the table: those the server named so, and
   * when there is none, the grants without a name that carry the ids of the record.
   * A grant has no name while the server refuses its claim without one.
   */
  private _grantsFor(name: string): IGrant[] {
    const named = this._grants.filter(grant => grant.name === name);
    if (named.length > 0) {
      return named;
    }
    const serial = this._devices.serial.find(record => record.name === name);
    const usb = this._devices.usb.find(record => record.name === name);
    const record = serial || usb;
    if (!record) {
      return [];
    }
    const kind: DeviceKind = serial ? 'serial' : 'usb';
    const serialNumber = usb ? usb.serialNumber : null;
    return this._grants.filter(
      grant =>
        grant.name === null &&
        grant.kind === kind &&
        (grant.vendorId ?? null) === record.vendorId &&
        (grant.productId ?? null) === record.productId &&
        (grant.serialNumber ?? null) === serialNumber
    );
  }

  private _keysFor(name: string, attached: boolean): string[] {
    return this._grantsFor(name)
      .filter(grant => grant.attached === attached)
      .map(grant => grant.key);
  }

  private async _requestPort(
    filter?: SerialPortFilter
  ): Promise<IGrantedDevice> {
    const port = await this._ask('serial', () =>
      navigator.serial.requestPort(filter ? { filters: [filter] } : undefined)
    );
    const { usbVendorId, usbProductId } = port.getInfo();
    return { kind: 'serial', vendorId: usbVendorId, productId: usbProductId };
  }

  private async _requestDevice(
    filters: USBDeviceFilter[]
  ): Promise<IGrantedDevice> {
    const device = await this._ask('usb', () =>
      navigator.usb.requestDevice({ filters })
    );
    return {
      kind: 'usb',
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber || undefined
    };
  }

  /**
   * Open a grant dialog. `open` runs before the first await of the caller's chain, so
   * the browser still sees the user gesture.
   */
  private async _ask<T>(kind: DeviceKind, open: () => Promise<T>): Promise<T> {
    if (!this.interfaces[kind]) {
      throw new GrantError('unsupported', {
        name: 'NotSupportedError',
        message: ABSENT_MESSAGE
      });
    }
    try {
      return await open();
    } catch (error) {
      const { name = 'Error', message = String(error) } = Object(
        error
      ) as Partial<IErrorInfo>;
      throw new GrantError(GRANT_FAILURES[name] || 'failed', { name, message });
    }
  }

  private readonly _serverSettings: ServerConnection.ISettings;
  private readonly _worker: Worker;
  private readonly _devicesChanged = new Signal<this, IDeviceTable>(this);
  private readonly _tabIdChanged = new Signal<this, string | null>(this);
  private readonly _requestsChanged = new Signal<this, IDeviceRequest[]>(this);
  private readonly _runsChanged = new Signal<this, IRunRecord[]>(this);
  private readonly _roundTripChanged = new Signal<this, number | null>(this);
  private readonly _activity = new Signal<this, IDeviceActivity[]>(this);

  private _devices = EMPTY_TABLE;
  private _grants: IGrant[] = [];
  private _tabId: string | null = null;
  private _profiles: IProfile[] = [];
  private _requests: IDeviceRequest[] = [];
  private _runs: IRunRecord[] = [];
  private _roundTrip: number | null = null;
  private _isDisposed = false;
}
