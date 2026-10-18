/**
 * The Devices panel of the left sidebar.
 *
 * It shows what the model reports: the device table, the device requests of container
 * programs, the runs and the round trip. A click that opens a dialog of the browser,
 * a dialog of the lab or a lab terminal goes to a handler of the plugin. The plus icon
 * opens a menu that the plugin made from its connect commands. Attach, detach,
 * forget, a settings change from the Settings dialog of a serial row and the stop of a
 * run go to the model.
 *
 * Hooks for the functional tests. Each one is an id or an attribute, never a class
 * name, and none of them changes with the text of a label.
 *
 *   panel root          #jupyterlab-device-bridge-panel
 *   plus icon           [data-action="add-device"] in the header; disabled when the
 *                       browser has neither interface. A click opens the menu that
 *                       the plugin made. The menu is a Lumino widget in the page
 *                       body, not in the panel. It has an entry only for an
 *                       interface the browser has:
 *                       [data-command="device-bridge:connect-serial"],
 *                       [data-command="device-bridge:connect-usb"]
 *   absent interfaces   [data-field="absent"]; hidden when the browser has both
 *   device row          [data-device="<name>"] with data-kind="serial|usb",
 *                       data-state="attached|detached", data-owner="this|other|none"
 *     fields            [data-field="kind"]      Serial | USB
 *                       [data-field="name"]      the device name
 *                       [data-field="state"]     attached | detached | removed | held by another tab
 *                       [data-field="rx"]        bytes from the device, with its unit
 *                       [data-field="tx"]        bytes to the device, with its unit
 *                       [data-field="error"]     the reason text; hidden without an error
 *     lamps             [data-lamp="tx"]         TX
 *                       [data-lamp="rx"]         RX
 *                       A lamp is lit while it has the attribute data-lit: for 200 ms
 *                       from each event. For a device this tab holds the event is an
 *                       activity message of the worker, which comes for each 50 ms
 *                       with bytes. For a device another tab holds it is a device
 *                       table with a larger counter than the row showed before.
 *     serial row only   [data-field="baud"]      the baud rate of the port, digits only
 *                       [data-field="config"]    the name of the config, or custom
 *                       [data-field="on-open"]   the action on open
 *                       [data-field="holder"]    <program> (pid <n>) | none
 *     USB row only      [data-field="product"]   manufacturer and product name
 *                       [data-field="opened"]    yes | no
 *                       [data-field="holder"]    <program> | none
 *     buttons           [data-action="attach"], [data-action="detach"],
 *                       [data-action="forget"], on a serial row [data-action="terminal"]
 *                       and [data-action="settings"]
 *   Settings dialog     a dialog of the lab, not in the panel, with a table body of
 *                       six rows, one setting per row; the label is the row head and
 *                       the value cell holds the one control
 *                       [data-setting-field="config|baudRate|dataBits|parity|stopBits|onOpen"];
 *                       [data-setting-field="baudRate"] is a text field with a datalist
 *                       of the standard rates, and [data-setting-badge="custom"] is
 *                       the Custom badge that shows while the typed value is no
 *                       standard rate; the buttons Cancel, Delete config, Save as...
 *                       and Save carry the class jp-DeviceBridgeSettings-button, of
 *                       which Save is the one accent button and Delete config carries
 *                       the warning colour
 *   help button         [data-action="settings-help"] in the Serial and USB header;
 *                       a click opens the file `Device Bridge Help` at the root of the
 *                       contents in the lab's read-only Markdown Preview, or activates
 *                       that tab when it is open (the tab is made by src/index.ts)
 *   device section      [data-section="devices"]; its [data-field="count"] reads (<n>)
 *   request section     [data-section="requests"]; hidden while no request is pending
 *   request row         [data-request="<id>"] with [data-field="program"],
 *                       [data-field="device"], [data-field="reason"], [data-action="grant"]
 *   runs section        [data-section="runs"]; its [data-field="count"] reads (<n>)
 *     buttons           [data-action="start-run"]; [data-action="run-info"], hidden
 *                       while no run exists
 *     empty text        [data-field="empty"]; hidden while a run exists
 *   run row             [data-run="<pid>"]
 *     fields            [data-field="program"]   the program name
 *                       [data-field="pid"]       pid <n>
 *                       [data-field="command"]   the command line
 *                       [data-field="device"]    <device name> | no device
 *                       [data-field="state"]     stopped, on a row whose run ended;
 *                                                hidden while the run lives
 *     buttons           [data-action="copy-run"], which copies the command line the
 *                       row shows and reads Copied for 1.5 s; [data-action="stop-run"],
 *                       disabled on a row whose run ended
 *   round trip          [data-field="round-trip"]   <ms with one decimal> ms | not connected
 *   status bar item     #jupyterlab-device-bridge-status (src/status.ts); the number
 *                       of attached devices is in its [data-field="count"]
 *
 * A button or a field that a row does not offer has the attribute `hidden`; it is not
 * removed. Forget acts on the second click: the first click changes its label to
 * "Confirm forget", and a second click earlier than 500 ms after the first is ignored.
 * Stop of a run row does the same with the label "Confirm stop".
 *
 * A run row stays for 3 s after its first appearance when the server drops the run
 * earlier, so that a command which ends at once is still read; a run that lasted
 * longer leaves at once. A row that stays shows the run as stopped and disables Stop.
 */

import {
  Clipboard,
  Dialog,
  Notification,
  showDialog
} from '@jupyterlab/apputils';
import { addIcon } from '@jupyterlab/ui-components';

import { Menu, Widget } from '@lumino/widgets';

import { deviceIcon } from './icons';
import { DeviceBridgeModel } from './model';
import type {
  DeviceKind,
  IDeviceActivity,
  IDeviceRequest,
  IRunRecord,
  ISerialConfig,
  ISerialRecord,
  ISerialSettingsChange,
  ISettingsConfig,
  IUsbRecord,
  SerialAction
} from './protocol';

/** The id of the panel widget, which is also its name in the saved layout of the lab. */
export const PANEL_ID = 'jupyterlab-device-bridge-panel';

/** A second click on an armed button counts only after this time, so a double click does not confirm. */
export const ARM_DELAY_MS = 500;

/**
 * How long the Copy button of a run row reads Copied after the clipboard took the
 * command line. Long enough to be read, short enough that the next copy is one click.
 */
export const COPIED_MS = 1500;

/**
 * How long a run row stays after it appeared, when the server drops the run before
 * this time has passed. A run that ends at once would otherwise show no row at all.
 */
export const RUN_VISIBLE_MS = 3000;

/**
 * How long one event keeps a lamp of a device row lit. 200 ms makes a single blink
 * visible. The worker reports traffic every 50 ms, so steady traffic lights the
 * lamp again before it goes off.
 */
const LAMP_MS = 200;

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

/** The rates the Baud rate field lists; any other value shows the Custom badge. */
const STANDARD_BAUD_RATES = [
  300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 74880,
  115200, 230400, 460800, 921600
];

/** The class of the four buttons of the Settings dialog; style/base.css makes them slim. */
const SETTINGS_BUTTON_CLASS = 'jp-DeviceBridgeSettings-button';

/** Numbers the datalist of each Settings dialog, so two dialogs have no id in common. */
let baudLists = 0;

const VALUE_CLASS = 'jp-DeviceBridgePanel-value';

/** What the panel shows and the handlers of the clicks it does not act on itself. */
export interface IDeviceBridgePanelOptions {
  model: DeviceBridgeModel;
  /** The menu that the plus icon of the header opens: the connect commands of the interfaces the browser has. */
  addMenu: Menu;
  /** Open the dialog of the browser for the device request with this id. Called inside a click. */
  grantRequest: (id: string) => void;
  /** Open the serial terminal on the serial port with this name. */
  openTerminal: (name: string) => void;
  /** Open a device shell: a lab terminal whose shell runs with the shim. */
  startRun: () => void;
  /** Open the dialog that says how to connect a tool. */
  showRunInfo: () => void;
  /** Open the help tab of the panel, or activate it when it is open. */
  showHelp: () => void;
}

/**
 * A row of the device list or of the runs. It is made once for a device or a run and
 * updated in place, so an update of a table does not replace a field the user is
 * editing or a button the user has armed.
 */
interface IRow<R> {
  node: HTMLElement;
  update(record: R): void;
  /** End the timers of the row and what it hears of the model. Called when the row or the panel goes. */
  dispose?(): void;
}

/** The row of a run, which can be told that the server no longer lists the run. */
interface IRunRow extends IRow<IRunRecord> {
  /** Show the run as stopped and disable Stop. The row stays until the panel removes it. */
  ended(): void;
}

/** A button that acts on the second click; `disarm` returns it to the label of the first step. */
interface ITwoStepButton extends HTMLButtonElement {
  /** Return the button to its first-step label without acting. */
  disarm(): void;
}

/** An activity lamp of a device row: a circle with the label TX or RX. */
interface ILamp {
  node: HTMLElement;
  /** Light the lamp for `LAMP_MS` from now. */
  flash(): void;
  /** End the timer of a lit lamp. */
  dispose(): void;
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
 * A byte count with its unit: byte or bytes below 10 KB, kilobytes with one
 * decimal from 10 KB, megabytes with one decimal from 1 MB. A kilobyte count
 * that rounds to 1000.0 KB reads in megabytes instead.
 *
 * @param value The byte count
 * @returns For example `999 bytes`, `10.0 KB`, `1.0 MB`
 */
export function formatBytes(value: number): string {
  if (value < 10000) {
    return `${value} ${value === 1 ? 'byte' : 'bytes'}`;
  }
  // Kilobyte tenths as an integer, so the value that rounds to 1000.0 KB is
  // recognized without the error of a binary floating point division.
  const tenths = Math.round(value / 100);
  if (tenths >= 10000) {
    return `${(value / 1000000).toFixed(1)} MB`;
  }
  return `${(tenths / 10).toFixed(1)} KB`;
}

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

/** Give an element a tooltip with the full text of what it shows in short. */
function tip<T extends HTMLElement>(node: T, title: string): T {
  node.title = title;
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
 * A lamp for one direction of a device row. It is lit while it has the attribute
 * `data-lit`.
 *
 * @param name `tx` for the bytes to the device, `rx` for the bytes from it
 * @param label The text beside the circle
 * @param title What the lamp stands for
 */
function lamp(name: 'tx' | 'rx', label: string, title: string): ILamp {
  const node = el('span', 'jp-DeviceBridgePanel-lamp', label);
  node.dataset.lamp = name;
  node.title = title;
  let timer: number | undefined;
  return {
    node,
    flash(): void {
      node.dataset.lit = '';
      // A lamp that is lit already stays lit for the full time from now.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => delete node.dataset.lit, LAMP_MS);
    },
    dispose(): void {
      window.clearTimeout(timer);
    }
  };
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
): ITwoStepButton {
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
  }) as ITwoStepButton;
  node.classList.add('jp-mod-warn');
  node.disarm = () => arm(null);
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
 * The body of the Settings dialog of a serial port: a table with the saved config and
 * the five settings, one setting per row. Choosing a config fills the fields;
 * changing a field selects Custom.
 */
class SerialSettingsBody extends Widget {
  /**
   * @param record The record of the port when the dialog opens
   * @param configs The serial settings configs of the server
   */
  constructor(record: ISerialRecord, configs: ISettingsConfig[]) {
    super();
    this.addClass('jp-DeviceBridgeSettings');
    this._record = record;
    this._configs = configs;
    const baudRate = el('input', 'jp-DeviceBridgePanel-input');
    // A text field, not a number field: the arrow keys and the mouse wheel of a
    // number field would change the rate by 1 (DEF-PANEL-6).
    baudRate.type = 'text';
    baudRate.setAttribute('inputmode', 'numeric');
    const listId = `jp-DeviceBridgeSettings-baud-${++baudLists}`;
    baudRate.setAttribute('list', listId);
    baudRate.setAttribute('aria-label', 'Baud rate');
    const list = el('datalist', '');
    list.id = listId;
    list.append(
      ...STANDARD_BAUD_RATES.map(rate => new Option(String(rate), String(rate)))
    );
    const custom = el('span', 'jp-DeviceBridgeSettings-badge', 'Custom');
    custom.dataset.settingBadge = 'custom';
    custom.hidden = true;
    this._baudRate = baudRate;
    this._custom = custom;
    this._controls = [
      [
        'config',
        'Config',
        select([
          ['', 'Custom'],
          ...configs.map((item): [string, string] => [
            item.id,
            item.system ? item.name : `${item.name} (saved)`
          ])
        ])
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
    const table = el('table', 'jp-DeviceBridgeSettings-table');
    const tbody = el('tbody', '');
    for (const [key, label, control] of this._controls) {
      control.dataset.settingField = key;
      const head = el('th', 'jp-DeviceBridgePanel-fieldLabel', label);
      head.scope = 'row';
      const cell = el('td', 'jp-DeviceBridgeSettings-cell');
      cell.append(control);
      if (control === baudRate) {
        cell.append(custom, list);
      }
      const row = el('tr', '');
      row.append(head, cell);
      tbody.append(row);
    }
    table.append(tbody);
    this.node.append(table);
    const [, , config] = this._controls[0];
    config.addEventListener('change', () => {
      const chosen = this._configs.find(item => item.id === config.value);
      if (chosen) {
        this._fill(chosen);
      }
    });
    // The badge shows a value that is no standard rate, and every edit selects Custom
    // in the Config select.
    for (const [, , control] of this._controls.slice(1)) {
      control.addEventListener('input', () => {
        if (control === baudRate) {
          custom.hidden = STANDARD_BAUD_RATES.includes(Number(baudRate.value));
        }
        config.value = '';
      });
    }
    this._fill(record.configured);
    config.value = record.config ?? '';
  }

  /**
   * The request body: a saved config when the fields are its values, else each field
   * that differs from what the port has.
   *
   * @returns The body of the settings request; empty when nothing changed
   */
  getValue(): ISerialSettingsChange {
    const [, , config] = this._controls[0];
    const chosen = this._configs.find(item => item.id === config.value);
    if (chosen && this._same(chosen)) {
      return chosen.id === this._record.config ? {} : { config: chosen.id };
    }
    const change: Record<string, string | number> = {};
    for (const [key, , control] of this._controls.slice(1)) {
      const configured = this._record.configured as unknown as Record<
        string,
        unknown
      >;
      const value = control.value;
      if (value !== String(configured[key])) {
        change[key] = NUMBER_FIELDS.has(key) ? Number(value) : value;
      }
    }
    return change as ISerialSettingsChange;
  }

  /** The five values the fields show now. */
  current(): ISerialConfig {
    const values: Record<string, string | number> = {};
    for (const [key, , control] of this._controls.slice(1)) {
      const value = control.value;
      values[key] = NUMBER_FIELDS.has(key) ? Number(value) : value;
    }
    return values as unknown as ISerialConfig;
  }

  /** The user-saved config the port uses now; undefined for a system config or Custom. */
  applied(): ISettingsConfig | undefined {
    const [, , config] = this._controls[0];
    return this._configs.find(item => item.id === config.value && !item.system);
  }

  private _same(values: ISerialConfig): boolean {
    return this._controls
      .slice(1)
      .every(
        ([key, , control]) =>
          control.value === String(values[key as keyof ISerialConfig])
      );
  }

  private _fill(values: ISerialConfig): void {
    this._baudRate.value = String(values.baudRate);
    this._custom.hidden = STANDARD_BAUD_RATES.includes(values.baudRate);
    for (const [key, , control] of this._controls.slice(1)) {
      if (control !== this._baudRate) {
        control.value = String(values[key as keyof ISerialConfig]);
      }
    }
  }

  private readonly _record: ISerialRecord;
  private readonly _configs: ISettingsConfig[];
  private readonly _baudRate: HTMLInputElement;
  private readonly _custom: HTMLElement;
  private readonly _controls: Array<
    [
      key: keyof ISerialSettingsChange | 'config',
      label: string,
      control: HTMLInputElement | HTMLSelectElement
    ]
  >;
}

/** The body of the dialog that asks for the name of a saved config. */
class ConfigNameBody extends Widget {
  constructor() {
    super();
    this.addClass('jp-DeviceBridgeSettings');
    this._input = el('input', 'jp-DeviceBridgePanel-input');
    this._input.placeholder = 'My board';
    this._input.dataset.settingField = 'name';
    const labelled = el('label', 'jp-DeviceBridgePanel-field');
    labelled.append(
      el('span', 'jp-DeviceBridgePanel-fieldLabel', 'Name'),
      this._input
    );
    this.node.append(labelled);
  }

  /** The name the user typed, without surrounding spaces. */
  name(): string {
    return this._input.value.trim();
  }

  private readonly _input: HTMLInputElement;
}

/**
 * Ask for a name and save the five values of the dialog under it. The port then uses
 * the saved config.
 */
async function saveAs(
  record: ISerialRecord,
  body: SerialSettingsBody,
  model: DeviceBridgeModel
): Promise<void> {
  const prompt = new ConfigNameBody();
  const answer = await showDialog({
    title: `Save the serial settings of ${record.name}`,
    body: prompt,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Save' })]
  });
  if (!answer.button.accept || !prompt.name()) {
    return;
  }
  try {
    const saved = await model.saveConfig(prompt.name(), body.current());
    await model.setSettings(record.name, { config: saved.id });
    await model.refreshConfigs();
  } catch (error) {
    // Without `autoClose` the lab displays no toast.
    Notification.emit(
      `Config not saved: ${(error as Error).message}`,
      'error',
      {
        autoClose: false
      }
    );
  }
}

/**
 * Open the Settings dialog of a serial port. Save sends the chosen config or the
 * changed fields; Save as stores the values under a name; Delete config removes the
 * user-saved config the port uses. Cancel changes nothing.
 *
 * @param record The record of the port
 * @param model The model of the device bridge
 */
async function editSettings(
  record: ISerialRecord,
  model: DeviceBridgeModel
): Promise<void> {
  const body = new SerialSettingsBody(record, model.configs);
  const result = await showDialog({
    title: `Serial settings of ${record.name}`,
    body,
    buttons: [
      Dialog.cancelButton({ className: SETTINGS_BUTTON_CLASS }),
      Dialog.warnButton({
        label: 'Delete config',
        className: SETTINGS_BUTTON_CLASS
      }),
      Dialog.createButton({
        label: 'Save as...',
        accept: false,
        className: SETTINGS_BUTTON_CLASS
      }),
      Dialog.okButton({ label: 'Save', className: SETTINGS_BUTTON_CLASS })
    ]
  });
  if (result.button.label === 'Delete config') {
    const applied = body.applied();
    if (!applied) {
      Notification.emit('The port uses no saved config to delete', 'warning');
      return;
    }
    try {
      await model.deleteConfig(applied.id);
      await model.refreshConfigs();
    } catch (error) {
      Notification.emit(
        `Config not deleted: ${(error as Error).message}`,
        'error',
        {
          autoClose: false
        }
      );
    }
    return;
  }
  if (result.button.label === 'Save as...') {
    await saveAs(record, body, model);
    return;
  }
  if (!result.button.accept) {
    return;
  }
  const change = body.getValue();
  if (Object.keys(change).length === 0) {
    return;
  }
  try {
    await model.setSettings(record.name, change);
  } catch (error) {
    // Without `autoClose` the lab displays no toast.
    Notification.emit(
      `Settings not changed: ${(error as Error).message}`,
      'error',
      { autoClose: false }
    );
  }
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
  const txLamp = lamp('tx', 'TX', 'bytes to the device');
  const rxLamp = lamp('rx', 'RX', 'bytes from the device');
  const lamps = el('div', 'jp-DeviceBridgePanel-lamps');
  lamps.append(txLamp.node, rxLamp.node);
  // The worker of this tab names the devices whose bytes it moved, every 50 ms.
  const onActivity = (_: unknown, devices: IDeviceActivity[]): void => {
    const moved = devices.find(device => device.name === name);
    if (moved?.tx) {
      txLamp.flash();
    }
    if (moved?.rx) {
      rxLamp.flash();
    }
  };
  model.activity.connect(onActivity);
  /** The counters of the last device table; null before the first one. */
  let shown: { rx: number; tx: number } | null = null;
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
  const traffic = tip(
    line('RX ', rx, ', TX ', tx),
    'Bytes from the device (RX) and to the device (TX)'
  );

  node.append(header, details, lamps, traffic, error, actions);
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
      rx.textContent = formatBytes(record.rx);
      tx.textContent = formatBytes(record.tx);
      // The worker of another tab moves the bytes of that tab's device. This tab sees
      // only its counters grow, once a second.
      if (owner !== 'this' && shown) {
        if (record.tx > shown.tx) {
          txLamp.flash();
        }
        if (record.rx > shown.rx) {
          rxLamp.flash();
        }
      }
      shown = { rx: record.rx, tx: record.tx };
      error.textContent = failure ?? '';
      error.hidden = !failure;
      attach.hidden = owner !== 'none' || !model.hasGrant(name);
      detach.hidden = owner !== 'this';
      forget.hidden = owner === 'other';
    },
    dispose(): void {
      model.activity.disconnect(onActivity);
      txLamp.dispose();
      rxLamp.dispose();
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
  const config = field('config');
  const onOpen = field('on-open');
  const holder = field('holder');
  row.details.append(
    line(baud, ' baud, config ', config, ', on open ', onOpen),
    line('Program: ', holder)
  );
  const terminal = button(
    'terminal',
    'Terminal',
    'Open a lab terminal with a serial terminal program on this port',
    () => openTerminal(first.name)
  );
  let shown = first;
  const settings = button(
    'settings',
    'Settings',
    'Change the serial settings and the action on open of this port',
    () => void editSettings(shown, model)
  );
  row.actions.prepend(terminal, settings);

  return {
    node: row.node,
    update(record: ISerialRecord): void {
      shown = record;
      row.update(record);
      baud.textContent = String(record.settings.baudRate);
      config.textContent = record.configName ?? 'custom';
      onOpen.textContent = ACTION_LABELS[record.configured.onOpen];
      holder.textContent = record.holder
        ? `${record.holder.name} (pid ${record.holder.pid})`
        : 'none';
      terminal.hidden = record.state !== 'attached';
    },
    dispose: row.dispose
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
    tip(
      line('Opened: ', opened),
      'Whether a program in the container has the device open'
    ),
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
    },
    dispose: row.dispose
  };
}

/**
 * The row of one run: program, process id, command line, device, the Copy button and
 * the Stop button. The row shows a stopped state once the server no longer lists the
 * run, and it disables Stop then.
 *
 * @param pid The process id of the run
 * @param model The model of the device bridge
 */
function runRow(pid: number, model: DeviceBridgeModel): IRunRow {
  const program = field('program', 'jp-DeviceBridgePanel-itemName');
  const state = field('state', 'jp-DeviceBridgePanel-state');
  state.hidden = true;
  const header = el('div', 'jp-DeviceBridgePanel-itemHeader');
  header.append(
    program,
    field('pid', 'jp-DeviceBridgePanel-pid', `pid ${pid}`),
    state
  );
  const command = field('command', 'jp-DeviceBridgePanel-command');
  const device = field('device');
  let copyTimer: number | undefined;
  const copy = button('copy-run', 'Copy', 'Copy the command line', () => {
    Clipboard.copyToSystem(command.textContent ?? '');
    copy.textContent = 'Copied';
    // A second click while the label reads Copied keeps it for the full time from now.
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copy.textContent = 'Copy';
    }, COPIED_MS);
  });
  const stop = twoStepButton(
    'stop-run',
    'Stop',
    'End this program. The server ends it by force when it still runs 3 seconds later',
    () => {
      model.stopRun(pid).catch((error: Error) => {
        // Without `autoClose` the lab displays no toast.
        Notification.emit(`Not stopped: ${error.message}`, 'error', {
          autoClose: false
        });
      });
    }
  );
  const actions = el('div', 'jp-DeviceBridgePanel-itemActions');
  actions.append(copy, stop);

  const node = el('div', 'jp-DeviceBridgePanel-item');
  node.dataset.run = String(pid);
  node.append(header, line(command), line('Device: ', device), actions);
  return {
    node,
    update(run: IRunRecord): void {
      // A tool that `jupyterlab-device run` became holds the device under the
      // process id of the run.
      const held = model.devices.serial.find(
        record => record.holder?.pid === pid
      );
      program.textContent = run.program;
      command.textContent = run.command;
      copy.title = `Copy the command line: ${run.command}`;
      device.textContent = run.device || held?.name || 'no device';
    },
    ended(): void {
      state.textContent = 'stopped';
      state.hidden = false;
      stop.disarm();
      stop.disabled = true;
    },
    dispose(): void {
      window.clearTimeout(copyTimer);
    }
  };
}

/**
 * Bring the rows of one list in line with its table: remove the row of a record that
 * is gone and end its timers, make a row for a new record, update every row.
 */
function syncRows<K, R>(
  list: HTMLElement,
  rows: Map<K, IRow<R>>,
  records: R[],
  keyOf: (record: R) => K,
  create: (record: R) => IRow<R>
): void {
  const keys = new Set(records.map(keyOf));
  for (const [key, row] of rows) {
    if (!keys.has(key)) {
      row.dispose?.();
      row.node.remove();
      rows.delete(key);
    }
  }
  for (const record of records) {
    const key = keyOf(record);
    let row = rows.get(key);
    if (!row) {
      row = create(record);
      rows.set(key, row);
      list.append(row.node);
    }
    row.update(record);
  }
}

/**
 * A section of the panel body: a header with a title and a count, then the content.
 * The title is short; its tooltip says what the section holds.
 */
function section(
  name: string,
  [title, tooltip]: [title: string, tooltip: string],
  count: HTMLElement,
  ...content: HTMLElement[]
): HTMLElement {
  const header = el('div', 'jp-DeviceBridgePanel-sectionHeader');
  header.append(
    tip(el('span', 'jp-DeviceBridgePanel-sectionTitle', title), tooltip),
    count
  );
  const node = el('div', 'jp-DeviceBridgePanel-section');
  node.dataset.section = name;
  node.append(header, ...content);
  return node;
}

/**
 * The Devices panel: the device table of the server, the device requests of container
 * programs, the runs and the round trip, with the buttons that act on them.
 *
 * @example
 * const panel = new DeviceBridgePanel({ model, addMenu, grantRequest, openTerminal, startRun, showRunInfo, showHelp });
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

    // The plus icon of the lab is the one control that adds a device. It is not made
    // by `button`, which gives a button the frame and the padding of a text button.
    const add = this._add;
    add.type = 'button';
    add.dataset.action = 'add-device';
    add.title = 'Add a serial port or a USB device';
    add.setAttribute('aria-haspopup', 'menu');
    add.disabled = !model.interfaces.serial && !model.interfaces.usb;
    addIcon.element({ container: add });
    add.addEventListener('click', () => {
      // Below the icon, the left edges in one line.
      const rect = add.getBoundingClientRect();
      options.addMenu.open(rect.left, rect.bottom);
    });
    // The open menu has the focus, and a menu that closes gives it to no element, so
    // the icon takes it. The panel is the receiver of the signal, so `dispose` ends
    // this connection with the other connections of the panel.
    options.addMenu.aboutToClose.connect(this._focusAdd, this);
    const header = el('div', 'jp-DeviceBridgePanel-header');
    header.append(
      el('span', 'jp-DeviceBridgePanel-headerTitle', 'Devices'),
      add
    );

    // The interfaces the browser does not give this page: the name and what it reaches.
    const missing = [
      model.interfaces.serial ? null : ['Web Serial', 'serial ports'],
      model.interfaces.usb ? null : ['WebUSB', 'USB devices']
    ].filter((names): names is string[] => names !== null);
    const absent = field(
      'absent',
      'jp-DeviceBridgePanel-banner',
      `${missing.map(([name]) => name).join(' and ')} ${missing.length === 1 ? 'needs' : 'need'} HTTPS or localhost, in Chrome or Edge`
    );
    absent.title = `The browser gives this page no access to ${missing.map(([, reached]) => reached).join(' and ')}. Open the lab over HTTPS or at localhost, in Chrome or Edge.`;
    absent.hidden = missing.length === 0;

    this._requestSection = section(
      'requests',
      ['Requests', 'Requests of programs in the container for a device'],
      this._requestCount,
      this._requestList
    );
    const startRun = button(
      'start-run',
      'Start',
      'Open a device shell',
      options.startRun
    );
    this._runInfo = button(
      'run-info',
      'Info',
      'Show how to connect a tool to an attached device',
      options.showRunInfo
    );
    const runActions = el('div', 'jp-DeviceBridgePanel-sectionActions');
    runActions.append(startRun, this._runInfo);
    const devices = section(
      'devices',
      ['Serial and USB', 'Serial ports and USB devices of this computer'],
      this._deviceCount,
      this._serialList,
      this._usbList,
      this._empty
    );
    const help = el('button', 'jp-DeviceBridgePanel-help', 'help');
    help.type = 'button';
    help.dataset.action = 'settings-help';
    help.title = 'Open the Device Bridge help';
    help.setAttribute('aria-label', 'Device Bridge help');
    help.addEventListener('click', () => options.showHelp());
    devices.querySelector('.jp-DeviceBridgePanel-sectionHeader')!.append(help);
    const body = el('div', 'jp-DeviceBridgePanel-body');
    body.append(
      this._requestSection,
      devices,
      section(
        'runs',
        [
          'Device shells',
          'Device shells and tools started with jupyterlab-device run'
        ],
        this._runCount,
        runActions,
        this._runList,
        this._runEmpty
      )
    );

    const footer = tip(
      el('div', 'jp-DeviceBridgePanel-footer'),
      'Round trip of a message from the browser to the server and back'
    );
    footer.append('Round trip: ', this._roundTrip);
    this.node.append(header, absent, body, footer);

    model.devicesChanged.connect(this._renderDevices, this);
    model.requestsChanged.connect(this._renderRequests, this);
    model.runsChanged.connect(this._renderRuns, this);
    // The device of a run row can be the serial port that the process of the run holds.
    model.devicesChanged.connect(this._renderRuns, this);
    model.roundTripChanged.connect(this._renderRoundTrip, this);
    this._renderDevices();
    this._renderRequests();
    this._renderRuns();
    this._renderRoundTrip();
  }

  /** End the timers of the lamps and of the run rows and what the rows hear of the model, so that nothing touches a row of a disposed panel. */
  dispose(): void {
    for (const row of [
      ...this._serialRows.values(),
      ...this._usbRows.values(),
      ...this._runRows.values()
    ]) {
      row.dispose?.();
    }
    for (const timer of this._runTimers.values()) {
      window.clearTimeout(timer);
    }
    this._runTimers.clear();
    super.dispose();
  }

  private _renderDevices(): void {
    const { serial, usb } = this._model.devices;
    const nameOf = (record: { name: string }): string => record.name;
    syncRows(this._serialList, this._serialRows, serial, nameOf, record =>
      serialRow(record, this._model, this._options.openTerminal)
    );
    syncRows(this._usbList, this._usbRows, usb, nameOf, record =>
      usbRow(record, this._model)
    );
    const count = serial.length + usb.length;
    this._deviceCount.textContent = `(${count})`;
    this._empty.hidden = count > 0;
  }

  private _renderRuns(): void {
    const runs = this._model.runs;
    const listed = new Set(runs.map(run => run.pid));
    const now = Date.now();
    // A run that the server drops within RUN_VISIBLE_MS of its first appearance
    // stays until that time has passed, so a command that ends at once is still read.
    for (const [pid, row] of this._runRows) {
      if (listed.has(pid)) {
        continue;
      }
      const remaining =
        RUN_VISIBLE_MS - (now - (this._runSeen.get(pid) ?? now));
      // While the WebSocket is closed, nothing the server sent before is true.
      if (remaining <= 0 || this._model.roundTrip === null) {
        this._removeRun(pid);
      } else if (!this._runTimers.has(pid)) {
        row.ended();
        const timer = window.setTimeout(() => {
          this._runTimers.delete(pid);
          this._removeRun(pid);
          this._updateRunSummary();
        }, remaining);
        this._runTimers.set(pid, timer);
      }
    }
    for (const run of runs) {
      let row = this._runRows.get(run.pid);
      if (!row) {
        row = runRow(run.pid, this._model);
        this._runRows.set(run.pid, row);
        this._runSeen.set(run.pid, now);
        this._runList.append(row.node);
      }
      row.update(run);
    }
    this._updateRunSummary();
  }

  /** Remove the row of one run and its linger timer, if any. */
  private _removeRun(pid: number): void {
    const row = this._runRows.get(pid);
    if (!row) {
      return;
    }
    row.dispose?.();
    row.node.remove();
    this._runRows.delete(pid);
    this._runSeen.delete(pid);
    const timer = this._runTimers.get(pid);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this._runTimers.delete(pid);
    }
  }

  /** The count of the runs section, its empty text and Info follow the rows it shows. */
  private _updateRunSummary(): void {
    const count = this._runRows.size;
    this._runCount.textContent = `(${count})`;
    this._runEmpty.hidden = count > 0;
    this._runInfo.hidden = count === 0;
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

  private _focusAdd(): void {
    this._add.focus();
  }

  private readonly _model: DeviceBridgeModel;
  private readonly _options: IDeviceBridgePanelOptions;
  private readonly _add = el('button', 'jp-DeviceBridgePanel-iconButton');
  private readonly _serialRows = new Map<string, IRow<ISerialRecord>>();
  private readonly _usbRows = new Map<string, IRow<IUsbRecord>>();
  private readonly _serialList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _usbList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _empty = tip(
    el('div', 'jp-DeviceBridgePanel-empty', 'No device attached'),
    'No device yet. Add a serial port or a USB device of this computer with the plus icon above.'
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
  private readonly _runRows = new Map<number, IRunRow>();
  /** The moment each run row first appeared, for RUN_VISIBLE_MS. */
  private readonly _runSeen = new Map<number, number>();
  /** The timer of each run row that stays after the server dropped its run. */
  private readonly _runTimers = new Map<number, number>();
  private readonly _runList = el('div', 'jp-DeviceBridgePanel-list');
  private readonly _runEmpty = tip(
    field('empty', 'jp-DeviceBridgePanel-empty', 'No device shell opened'),
    'No device shell is open. Start opens a terminal in which tools control the lines of the serial ports.'
  );
  private readonly _runCount = field(
    'count',
    'jp-DeviceBridgePanel-sectionCount'
  );
  private readonly _runInfo: HTMLButtonElement;
  private readonly _roundTrip = field('round-trip');
}
