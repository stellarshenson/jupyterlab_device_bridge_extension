/**
 * The Devices panel of the left sidebar.
 *
 * It shows what the model reports: the device table, the device requests of container
 * programs and the round trip. A click that opens a dialog of the browser or a lab
 * terminal goes to a handler of the plugin. Attach, detach, forget and a profile
 * change go to the model.
 *
 * Hooks for the functional tests. Each one is an id or an attribute, never a class
 * name, and none of them changes with the text of a label.
 *
 *   panel root          #jupyterlab-device-bridge-panel
 *   add buttons         [data-action="connect-serial"], [data-action="connect-usb"];
 *                       disabled when the browser lacks that interface
 *   absent interfaces   [data-field="absent"]; hidden when the browser has both
 *   device row          [data-device="<name>"] with data-kind="serial|usb",
 *                       data-state="attached|detached", data-owner="this|other|none"
 *     fields            [data-field="kind"]      Serial | USB
 *                       [data-field="name"]      the device name
 *                       [data-field="state"]     attached | detached | removed | held by another tab
 *                       [data-field="rx"]        bytes from the device, digits only
 *                       [data-field="tx"]        bytes to the device, digits only
 *                       [data-field="error"]     the reason text; hidden without an error
 *     serial row only   [data-field="baud"]      the baud rate of the port, digits only
 *                       [data-field="profile"]   the profile id
 *                       [data-field="holder"]    <program> (pid <n>) | none
 *     USB row only      [data-field="product"]   manufacturer and product name
 *                       [data-field="opened"]    yes | no
 *                       [data-field="holder"]    <program> | none
 *     buttons           [data-action="attach"], [data-action="detach"],
 *                       [data-action="forget"], on a serial row [data-action="terminal"]
 *     profile editor    [data-profile-field="profile|baudRate|dataBits|parity|stopBits|onOpen"]
 *                       inside the <details> of a serial row; a change event sends the value
 *   device section      [data-section="devices"]; its [data-field="count"] reads (<n>)
 *   request section     [data-section="requests"]; hidden while no request is pending
 *   request row         [data-request="<id>"] with [data-field="program"],
 *                       [data-field="device"], [data-field="reason"], [data-action="grant"]
 *   round trip          [data-field="round-trip"]   <ms with one decimal> ms | not connected
 *   status bar item     #jupyterlab-device-bridge-status (src/status.ts); the number
 *                       of attached devices is in its [data-field="count"]
 *
 * A button or a field that a row does not offer has the attribute `hidden`; it is not
 * removed. Forget acts on the second click: the first click changes its label to
 * "Confirm forget", and a second click earlier than 500 ms after the first is ignored.
 */

import { Notification } from '@jupyterlab/apputils';

import { Widget } from '@lumino/widgets';

import { deviceIcon } from './icons';
import { DeviceBridgeModel } from './model';
import type {
  DeviceKind,
  IDeviceRequest,
  IProfileChange,
  ISerialRecord,
  IUsbRecord,
  SerialAction
} from './protocol';

/** The id of the panel widget, which is also its name in the saved layout of the lab. */
export const PANEL_ID = 'jupyterlab-device-bridge-panel';

/** A second click on an armed button counts only after this time, so a double click does not confirm. */
export const ARM_DELAY_MS = 500;

const KIND_LABELS: Record<DeviceKind, string> = {
  serial: 'Serial',
  usb: 'USB'
};

const KIND_NAMES: Record<DeviceKind, string> = {
  serial: 'serial port',
  usb: 'USB device'
};

/** Who holds a device, seen from this tab. */
type Owner = 'this' | 'other' | 'none';

const STATE_TEXTS: Record<Owner, string> = {
  this: 'attached',
  other: 'held by another tab',
  none: 'detached'
};

/**
 * What the server puts into `error` of a detached device that left the computer. The
 * row shows it as the state of the device, because nothing failed.
 */
const REMOVED = 'removed';

const ACTION_LABELS: Record<SerialAction, string> = {
  none: 'Do nothing',
  'pulse-dtr': 'Pulse DTR',
  'pulse-rts': 'Pulse RTS',
  'esp-bootloader': 'Enter the ESP bootloader',
  'touch-1200': 'Open at 1200 baud and close'
};

/** The fields of a profile change that the server takes as a number. */
const NUMBER_FIELDS = new Set(['baudRate', 'dataBits', 'stopBits']);

const VALUE_CLASS = 'jp-DeviceBridgePanel-value';

/** What the panel shows and the handlers of the clicks it does not act on itself. */
export interface IDeviceBridgePanelOptions {
  model: DeviceBridgeModel;
  /** Open the serial port dialog of the browser. Called inside a click. */
  connectSerial: () => void;
  /** Open the USB device dialog of the browser. Called inside a click. */
  connectUsb: () => void;
  /** Open the dialog of the browser for the device request with this id. Called inside a click. */
  grantRequest: (id: string) => void;
  /** Open the serial terminal on the serial port with this name. */
  openTerminal: (name: string) => void;
}

/**
 * A row of the device list. It is made once for a device and updated in place, so an
 * update of the device table does not replace a field the user is editing.
 */
interface IRow<R> {
  node: HTMLElement;
  update(record: R): void;
}

/** The part of a device row that a serial port and a USB device share. */
interface IDeviceRow extends IRow<ISerialRecord | IUsbRecord> {
  /** Holds the lines that only one kind of device has. */
  details: HTMLElement;
  actions: HTMLElement;
}

/**
 * A vendor or product id as programs write it: 4 lowercase hex digits.
 *
 * @param id The id as a number
 * @returns For example `0d28`
 */
const hexId = (id: number): string => id.toString(16).padStart(4, '0');

/**
 * Say in words which device a container program asks for.
 *
 * @param request The device request
 * @returns For example `USB device with vendor id 0d28 and product id 0204`
 */
export function requestedDevice(request: IDeviceRequest): string {
  const ids: string[] = [];
  if (typeof request.vendorId === 'number') {
    ids.push(`vendor id ${hexId(request.vendorId)}`);
  }
  if (typeof request.productId === 'number') {
    ids.push(`product id ${hexId(request.productId)}`);
  }
  const kind = KIND_NAMES[request.kind];
  return ids.length > 0 ? `${kind} with ${ids.join(' and ')}` : kind;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** A value that a test reads: an element with `data-field`. */
function field(name: string, className = VALUE_CLASS, text = ''): HTMLElement {
  const node = el('span', className, text);
  node.dataset.field = name;
  return node;
}

/** One line of a row: fixed texts and the elements of the values between them. */
function line(...parts: Array<string | HTMLElement>): HTMLElement {
  const node = el('div', 'jp-DeviceBridgePanel-detail');
  node.append(...parts);
  return node;
}

function button(
  action: string,
  label: string,
  title: string,
  onClick: () => void
): HTMLButtonElement {
  const node = el('button', 'jp-DeviceBridgePanel-button', label);
  node.type = 'button';
  node.dataset.action = action;
  node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

/**
 * A button for an action that removes something. The first click arms it and changes
 * the label to "Confirm <label>"; the second click acts. It is disarmed when the
 * focus leaves it.
 */
function twoStepButton(
  action: string,
  label: string,
  title: string,
  act: () => void
): HTMLButtonElement {
  let armedAt: number | null = null;
  const arm = (at: number | null): void => {
    armedAt = at;
    node.textContent = at === null ? label : `Confirm ${label.toLowerCase()}`;
    node.classList.toggle('jp-mod-confirm', at !== null);
  };
  const node = button(action, label, title, () => {
    if (armedAt === null) {
      arm(Date.now());
    } else if (Date.now() - armedAt >= ARM_DELAY_MS) {
      arm(null);
      act();
    }
  });
  node.classList.add('jp-mod-warn');
  node.addEventListener('blur', () => arm(null));
  return node;
}

function select(
  choices: Array<[value: string, label: string]>
): HTMLSelectElement {
  const node = el('select', 'jp-DeviceBridgePanel-input');
  node.append(...choices.map(([value, label]) => new Option(label, value)));
  return node;
}

/**
 * The profile editor of a serial port: the profile id and the single fields that
 * override it. A change of a field goes to the server at once.
 *
 * @param first The record the editor shows first
 * @param model The model of the device bridge
 */
function profileEditor(
  first: ISerialRecord,
  model: DeviceBridgeModel
): IRow<ISerialRecord> {
  let shown = first;
  const baudRate = el('input', 'jp-DeviceBridgePanel-input');
  // Not a number field: its arrow keys and the mouse wheel change the value by 1.
  baudRate.type = 'text';
  baudRate.setAttribute('inputmode', 'numeric');
  const controls: Array<
    [
      key: keyof IProfileChange,
      label: string,
      control: HTMLInputElement | HTMLSelectElement
    ]
  > = [
    [
      'profile',
      'Profile',
      select(model.profiles.map(profile => [profile.id, profile.label]))
    ],
    ['baudRate', 'Baud rate', baudRate],
    [
      'dataBits',
      'Data bits',
      select([
        ['7', '7'],
        ['8', '8']
      ])
    ],
    [
      'parity',
      'Parity',
      select([
        ['none', 'None'],
        ['even', 'Even'],
        ['odd', 'Odd']
      ])
    ],
    [
      'stopBits',
      'Stop bits',
      select([
        ['1', '1'],
        ['2', '2']
      ])
    ],
    [
      'onOpen',
      'When a program opens the port',
      select(Object.entries(ACTION_LABELS))
    ]
  ];

  /** Write the profile of the shown record, with its overrides, into the fields. */
  const fill = (everyField: boolean): void => {
    const values = {
      // Stand in for a profile id that is not in the list of the server.
      ...shown.settings,
      onOpen: 'none',
      ...model.profiles.find(profile => profile.id === shown.profile),
      ...shown.overrides,
      profile: shown.profile
    };
    for (const [key, , control] of controls) {
      const value = String(values[key]);
      // The user may be typing a baud rate: an update of the device table leaves it.
      const typing = control === baudRate && document.activeElement === control;
      if (control.value !== value && (everyField || !typing)) {
        control.value = value;
      }
    }
  };

  const node = el('details', 'jp-DeviceBridgePanel-profile');
  node.append(
    el('summary', 'jp-DeviceBridgePanel-profileSummary', 'Profile settings')
  );
  for (const [key, label, control] of controls) {
    control.dataset.profileField = key;
    control.addEventListener('change', () => {
      const value = NUMBER_FIELDS.has(key)
        ? Number(control.value)
        : control.value;
      model
        .setProfile(shown.name, { [key]: value } as IProfileChange)
        .catch((error: Error) => {
          // Without `autoClose` the lab displays no toast.
          Notification.emit(
            `The profile of ${shown.name} was not changed: ${error.message}`,
            'error',
            { autoClose: false }
          );
          fill(true);
        });
    });
    const labelled = el('label', 'jp-DeviceBridgePanel-field');
    labelled.append(
      el('span', 'jp-DeviceBridgePanel-fieldLabel', label),
      control
    );
    node.append(labelled);
  }

  return {
    node,
    update(record: ISerialRecord): void {
      shown = record;
      fill(false);
    }
  };
}

/**
 * The part of a device row that both kinds have: kind, name, state, byte counters,
 * error text and the buttons Attach, Detach and Forget.
 */
function deviceRow(
  kind: DeviceKind,
  name: string,
  model: DeviceBridgeModel
): IDeviceRow {
  const node = el('div', 'jp-DeviceBridgePanel-item');
  node.dataset.device = name;
  node.dataset.kind = kind;

  const state = field('state', 'jp-DeviceBridgePanel-state');
  const header = el('div', 'jp-DeviceBridgePanel-itemHeader');
  header.append(
    field('kind', 'jp-DeviceBridgePanel-kind', KIND_LABELS[kind]),
    field('name', 'jp-DeviceBridgePanel-itemName', name),
    state
  );
  const details = el('div', 'jp-DeviceBridgePanel-details');
  const rx = field('rx');
  const tx = field('tx');
  const error = field('error', 'jp-DeviceBridgePanel-error');

  const attach = button(
    'attach',
    'Attach',
    'Open the device in this tab, so that programs in the container can use it',
    () => model.attach(name)
  );
  const detach = button(
    'detach',
    'Detach',
    'Close the device. The browser keeps its permission, so Attach opens it again without a dialog',
    () => model.detach(name)
  );
  const forget = twoStepButton(
    'forget',
    'Forget',
    'Close the device, remove it from this list and withdraw the permission of the browser',
    () => model.forget(name)
  );
  const actions = el('div', 'jp-DeviceBridgePanel-itemActions');
  actions.append(attach, detach, forget);

  node.append(
    header,
    details,
    line('From the device ', rx, ' bytes, to the device ', tx, ' bytes'),
    error,
    actions
  );
  return {
    node,
    details,
    actions,
    update(record: ISerialRecord | IUsbRecord): void {
      let owner: Owner = 'none';
      if (record.state === 'attached') {
        owner = record.tab === model.tabId ? 'this' : 'other';
      }
      node.dataset.state = record.state;
      node.dataset.owner = owner;
      const removed = owner === 'none' && record.error === REMOVED;
      const failure = removed ? null : record.error;
      state.textContent = removed ? REMOVED : STATE_TEXTS[owner];
      rx.textContent = String(record.rx);
      tx.textContent = String(record.tx);
      error.textContent = failure ?? '';
      error.hidden = !failure;
      attach.hidden = owner !== 'none' || !model.hasGrant(name);
      detach.hidden = owner !== 'this';
      forget.hidden = owner === 'other';
    }
  };
}

function serialRow(
  first: ISerialRecord,
  model: DeviceBridgeModel,
  openTerminal: (name: string) => void
): IRow<ISerialRecord> {
  const row = deviceRow('serial', first.name, model);
  const baud = field('baud');
  const profile = field('profile');
  const holder = field('holder');
  row.details.append(
    line(baud, ' baud, profile ', profile),
    line('Program: ', holder)
  );
  const terminal = button(
    'terminal',
    'Terminal',
    'Open a lab terminal with a serial terminal program on this port',
    () => openTerminal(first.name)
  );
  row.actions.prepend(terminal);
  const editor = profileEditor(first, model);
  row.node.append(editor.node);

  return {
    node: row.node,
    update(record: ISerialRecord): void {
      row.update(record);
      baud.textContent = String(record.settings.baudRate);
      profile.textContent = record.profile;
      holder.textContent = record.holder
        ? `${record.holder.name} (pid ${record.holder.pid})`
        : 'none';
      terminal.hidden = record.state !== 'attached';
      editor.update(record);
    }
  };
}

function usbRow(first: IUsbRecord, model: DeviceBridgeModel): IRow<IUsbRecord> {
  const row = deviceRow('usb', first.name, model);
  const product = field('product');
  const opened = field('opened');
  const holder = field('holder');
  const productLine = line(product);
  row.details.append(
    productLine,
    line('Open by a program: ', opened),
    line('Program: ', holder)
  );

  return {
    node: row.node,
    update(record: IUsbRecord): void {
      row.update(record);
      product.textContent = [record.manufacturerName, record.productName]
        .filter(Boolean)
        .join(' ');
      productLine.hidden = !product.textContent;
      opened.textContent = record.opened ? 'yes' : 'no';
      holder.textContent = record.holder ? record.holder.name : 'none';
    }
  };
}

/**
 * Bring the rows of one kind in line with the device table: remove the row of a
 * device that is gone, make a row for a new device, update every row.
 */
function syncRows<R extends { name: string }>(
  list: HTMLElement,
  rows: Map<string, IRow<R>>,
  records: R[],
  create: (record: R) => IRow<R>
): void {
  const names = new Set(records.map(record => record.name));
  for (const [name, row] of rows) {
    if (!names.has(name)) {
      row.node.remove();
      rows.delete(name);
    }
  }
  for (const record of records) {
    let row = rows.get(record.name);
    if (!row) {
      row = create(record);
      rows.set(record.name, row);
      list.append(row.node);
    }
    row.update(record);
  }
}

/** A section of the panel body: a header with a title and a count, then the content. */
function section(
  name: string,
  title: string,
  count: HTMLElement,
  ...content: HTMLElement[]
): HTMLElement {
  const header = el('div', 'jp-DeviceBridgePanel-sectionHeader');
  header.append(el('span', 'jp-DeviceBridgePanel-sectionTitle', title), count);
  const node = el('div', 'jp-DeviceBridgePanel-section');
  node.dataset.section = name;
  node.append(header, ...content);
  return node;
}

/**
 * The Devices panel: the device table of the server, the device requests of container
 * programs and the round trip, with the buttons that act on them.
 *
 * @example
 * const panel = new DeviceBridgePanel({ model, connectSerial, connectUsb, grantRequest, openTerminal });
 * app.shell.add(panel, 'left');
 */
export class DeviceBridgePanel extends Widget {
  constructor(options: IDeviceBridgePanelOptions) {
    super();
    const { model } = options;
    this._model = model;
    this._options = options;
    this.id = PANEL_ID;
    this.title.icon = deviceIcon;
    this.title.caption = 'Devices';
    this.addClass('jp-DeviceBridgePanel');

    const header = el('div', 'jp-DeviceBridgePanel-header');
    header.append(el('span', 'jp-DeviceBridgePanel-headerTitle', 'Devices'));

    const addSerial = button(
      'connect-serial',
      'Add serial port',
      'Choose a serial port of this computer in the dialog of the browser',
      options.connectSerial
    );
    const addUsb = button(
      'connect-usb',
      'Add USB device',
      'Choose a USB device of this computer in the dialog of the browser',
      options.connectUsb
    );
    addSerial.disabled = !model.interfaces.serial;
    addUsb.disabled = !model.interfaces.usb;
    const toolbar = el('div', 'jp-DeviceBridgePanel-toolbar');
    toolbar.append(addSerial, addUsb);

    const missing = [
      model.interfaces.serial ? '' : 'serial ports',
      model.interfaces.usb ? '' : 'USB devices'
    ].filter(Boolean);
    const absent = field(
      'absent',
      'jp-DeviceBridgePanel-banner',
      `The browser gives this page no access to ${missing.join(' and ')}. Open the lab over HTTPS or at localhost, in Chrome or Edge.`
    );
    absent.hidden = missing.length === 0;

    this._requestSection = section(
      'requests',
      'Requests of programs',
      this._requestCount,
      this._requestList
    );
    const body = el('div', 'jp-DeviceBridgePanel-body');
    body.append(
      this._requestSection,
      section(
        'devices',
        'Serial ports and USB devices',
        this._deviceCount,
        this._serialList,
        this._usbList,
        this._empty
      )
    );

    const footer = el('div', 'jp-DeviceBridgePanel-footer');
    footer.append('Browser to server round trip: ', this._roundTrip);
    this.node.append(header, toolbar, absent, body, footer);

    model.devicesChanged.connect(this._renderDevices, this);
    model.requestsChanged.connect(this._renderRequests, this);
    model.roundTripChanged.connect(this._renderRoundTrip, this);
    this._renderDevices();
    this._renderRequests();
    this._renderRoundTrip();
  }

  private _renderDevices(): void {
    const { serial, usb } = this._model.devices;
    syncRows(this._serialList, this._serialRows, serial, record =>
      serialRow(record, this._model, this._options.openTerminal)
    );
    syncRows(this._usbList, this._usbRows, usb, record =>
      usbRow(record, this._model)
    );
    const count = serial.length + usb.length;
    this._deviceCount.textContent = `(${count})`;
    this._empty.hidden = count > 0;
  }

  private _renderRequests(): void {
    const requests = this._model.requests;
    this._requestSection.hidden = requests.length === 0;
    this._requestCount.textContent = `(${requests.length})`;
    this._requestList.replaceChildren(
      ...requests.map(request => this._requestRow(request))
    );
  }

  private _requestRow(request: IDeviceRequest): HTMLElement {
    const header = el('div', 'jp-DeviceBridgePanel-itemHeader');
    header.append(
      field('program', 'jp-DeviceBridgePanel-itemName', request.program)
    );
    const grant = button(
      'grant',
      'Grant',
      'Choose the device in the dialog of the browser and attach it',
      () => this._options.grantRequest(request.id)
    );
    grant.classList.add('jp-mod-accept');
    const actions = el('div', 'jp-DeviceBridgePanel-itemActions');
    actions.append(grant);

    const node = el('div', 'jp-DeviceBridgePanel-item');
    node.dataset.request = request.id;
    node.append(
      header,
      line(
        'Asks for a ',
        field('device', VALUE_CLASS, requestedDevice(request))
      ),
      line('Reason: ', field('reason', VALUE_CLASS, request.reason)),
      actions
    );
    return node;
  }

  private _renderRoundTrip(): void {
    const ms = this._model.roundTrip;
    this._roundTrip.textContent =
      ms === null ? 'not connected' : `${ms.toFixed(1)} ms`;
  }

  private readonly _model: DeviceBridgeModel;
  private readonly _options: IDeviceBridgePanelOptions;
  private readonly _serialRows = new Map<string, IRow<ISerialRecord>>();
  private readonly _usbRows = new Map<string, IRow<IUsbRecord>>();
  private readonly _serialList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _usbList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _empty = el(
    'div',
    'jp-DeviceBridgePanel-empty',
    'No device yet. Add a serial port or a USB device of this computer with the buttons above.'
  );
  private readonly _deviceCount = field(
    'count',
    'jp-DeviceBridgePanel-sectionCount'
  );
  private readonly _requestSection: HTMLElement;
  private readonly _requestList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _requestCount = field(
    'count',
    'jp-DeviceBridgePanel-sectionCount'
  );
  private readonly _roundTrip = field('round-trip');
}
