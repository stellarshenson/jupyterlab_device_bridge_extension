/**
 * The status bar item of the device bridge.
 *
 * It tells the user that programs in the container have access to hardware: it shows
 * how many devices are attached to any tab of the lab. The plugin registers it so that
 * the status bar shows it only while that number is above zero.
 */

import { ISignal, Signal } from '@lumino/signaling';

import { Widget } from '@lumino/widgets';

import { deviceIcon } from './icons';
import { DeviceBridgeModel } from './model';

/** The id of the status bar item, by which a functional test finds it. */
const STATUS_ITEM_ID = 'jupyterlab-device-bridge-status';

/**
 * The number of attached devices, with the icon of the bridge. A click opens the panel.
 *
 * @example
 * const status = new DeviceBridgeStatus(model, showPanel);
 * statusBar.registerStatusItem(id, {
 *   item: status,
 *   isActive: () => status.count > 0,
 *   activeStateChanged: status.countChanged
 * });
 */
export class DeviceBridgeStatus extends Widget {
  /**
   * @param model The model of the device bridge
   * @param showPanel Called when the user clicks the item
   */
  constructor(model: DeviceBridgeModel, showPanel: () => void) {
    super();
    this._model = model;
    this.id = STATUS_ITEM_ID;
    this.addClass('jp-DeviceBridgeStatus');
    // The class of the lab for a status bar item that takes a click.
    this.addClass('jp-mod-highlighted');

    const icon = document.createElement('span');
    icon.className = 'jp-DeviceBridgeStatus-icon';
    deviceIcon.element({ container: icon });
    this._count.className = 'jp-DeviceBridgeStatus-count';
    this._count.dataset.field = 'count';
    this._label.className = 'jp-DeviceBridgeStatus-label';
    this.node.append(icon, this._count, this._label);
    this.node.addEventListener('click', showPanel);

    model.devicesChanged.connect(this._update, this);
    this._update();
  }

  /** The number of devices attached to any tab of the lab. */
  get count(): number {
    return this._attached;
  }

  /** Emitted when `count` changes. */
  get countChanged(): ISignal<this, void> {
    return this._countChanged;
  }

  private _update(): void {
    const { serial, usb } = this._model.devices;
    const before = this._attached;
    this._attached = [...serial, ...usb].filter(
      record => record.state === 'attached'
    ).length;
    const devices = this._attached === 1 ? 'device' : 'devices';
    this._count.textContent = String(this._attached);
    this._label.textContent = devices;
    this.node.title = `Programs in the container have access to ${this._attached} ${devices} of this computer. Click to show the Devices panel.`;
    if (this._attached !== before) {
      this._countChanged.emit();
    }
  }

  private readonly _model: DeviceBridgeModel;
  private readonly _count = document.createElement('span');
  private readonly _label = document.createElement('span');
  private readonly _countChanged = new Signal<this, void>(this);
  private _attached = 0;
}
