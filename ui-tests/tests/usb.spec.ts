import { expect, test } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';

import {
  action,
  addUsb,
  api,
  field,
  hex,
  IChild,
  ISimUsb,
  openLab,
  PANEL,
  PANEL_SHOWN,
  ROUND_TRIP,
  row,
  runCli,
  showPanel,
  simDialogs,
  simUsb,
  startCli,
  usbRecord,
  whileRunning
} from './helpers';

/**
 * Functional tests of a USB device: the real panel, worker and server, a simulated
 * device in the browser (device-sim.js) and the real `jupyterlab-device request`
 * command. Ids in the titles are the criteria of docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

/** Start `jupyterlab-device request usb` for a device; it runs until the user answers. */
function requestDevice(device: ISimUsb, reason: string): IChild {
  const child = startCli([
    'request',
    'usb',
    '--vid',
    hex(device.vendorId),
    '--pid',
    hex(device.productId),
    '--reason',
    reason,
    '--timeout',
    '40'
  ]);
  child.process.stdin!.end();
  return child;
}

/** The row of the pending request with this reason in the Devices panel. */
const requestRow = (page: Page, reason: string): Locator =>
  page
    .locator(`${PANEL} [data-section="requests"] [data-request]`)
    .filter({ hasText: reason });

/** The device request with this reason, as the server lists it. */
async function requestRecord(reason: string): Promise<any> {
  const { requests } = (await api('GET', 'requests')).body;
  return requests.find((request: any) => request.reason === reason);
}

test.describe('USB device', () => {
  test('ACC-USB-45 the add USB device button opens the device dialog of the browser and the granted device is listed as attached', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    expect(await simDialogs(page)).toEqual([]);

    await addUsb(page, device);

    expect(await simDialogs(page)).toEqual([
      {
        kind: 'usb',
        options: { filters: [] },
        outcome: 'granted',
        device: device.id
      }
    ]);
    const deviceRow = row(page, device.name);
    await expect(deviceRow).toHaveAttribute('data-kind', 'usb');
    await expect(field(deviceRow, 'state')).toHaveText('attached');
    expect(await usbRecord(device.name)).toMatchObject({
      state: 'attached',
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber,
      productName: device.productName,
      manufacturerName: device.manufacturerName,
      opened: false
    });
  });

  test('ACC-USB-46 a USB device granted earlier is attached after a page load without a click', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    await addUsb(page, device);
    const before = await usbRecord(device.name);

    await page.reload();

    // The tab of the new page holds the device, and nothing was clicked.
    await expect
      .poll(
        async () => {
          const record = await usbRecord(device.name);
          return record.tab !== before.tab && record.state;
        },
        { timeout: ROUND_TRIP }
      )
      .toBe('attached');
    expect(await simDialogs(page)).toEqual([]);
    await showPanel(page);
    await expect(field(row(page, device.name), 'state')).toHaveText('attached');
  });

  test('ACC-PANEL-112 after `jupyterlab-device usb open` the USB row names jupyterlab-device as the program, and no program after `usb close`', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    await addUsb(page, device);
    const deviceRow = row(page, device.name);
    await expect(field(deviceRow, 'opened')).toHaveText('no');
    await expect(field(deviceRow, 'holder')).toHaveText('none');
    expect((await usbRecord(device.name)).holder).toBeNull();

    const opened = await runCli(['usb', 'open', device.name]);
    expect(opened.code, `stderr: ${opened.stderr}`).toBe(0);

    await expect(field(deviceRow, 'holder')).toHaveText('jupyterlab-device', {
      timeout: ROUND_TRIP
    });
    await expect(field(deviceRow, 'opened')).toHaveText('yes');
    expect(await usbRecord(device.name)).toMatchObject({
      opened: true,
      holder: { name: 'jupyterlab-device' }
    });

    const closed = await runCli(['usb', 'close', device.name]);
    expect(closed.code, `stderr: ${closed.stderr}`).toBe(0);

    await expect(field(deviceRow, 'holder')).toHaveText('none', {
      timeout: ROUND_TRIP
    });
    await expect(field(deviceRow, 'opened')).toHaveText('no');
    expect(await usbRecord(device.name)).toMatchObject({
      opened: false,
      holder: null
    });
  });

  test('ACC-USB-47 a device request of a container program appears in the panel with the program name, the vendor and product id and the reason', async ({
    page
  }) => {
    const device = simUsb();
    const reason = `flash the board through ${device.name}`;
    await openLab(page, { usb: [device] });

    const cli = requestDevice(device, reason);

    const request = requestRow(page, reason);
    await whileRunning(
      cli,
      expect(request).toBeVisible({ timeout: ROUND_TRIP })
    );
    await expect(field(request, 'program')).toHaveText('jupyterlab-device');
    await expect(field(request, 'device')).toHaveText(
      `USB device with vendor id ${hex(device.vendorId)} and product id ${hex(device.productId)}`
    );
    await expect(field(request, 'reason')).toHaveText(reason);
    expect(await requestRecord(reason)).toMatchObject({
      state: 'pending',
      kind: 'usb',
      vendorId: device.vendorId,
      productId: device.productId,
      program: 'jupyterlab-device'
    });

    // The Grant button of the row ends the request, so that none stays pending.
    await action(request, 'grant').click();
    expect((await cli.done).code).toBe(0);
    await expect(request).toHaveCount(0);
  });

  test('ACC-USB-48 the grant click opens the device dialog with the requested vendor and product filter, attaches the device and ends the request as granted', async ({
    page
  }) => {
    const device = simUsb();
    const reason = `read the probe ${device.name}`;
    await openLab(page, { usb: [device] });

    const cli = requestDevice(device, reason);

    // The lab raises a notification with a Grant button; the click is the user gesture.
    const toast = page.locator('.Toastify__toast').filter({ hasText: reason });
    await whileRunning(cli, expect(toast).toBeVisible({ timeout: ROUND_TRIP }));
    await expect(toast).toContainText(
      `jupyterlab-device asks for a USB device with vendor id ${hex(device.vendorId)} and product id ${hex(device.productId)}: ${reason}`
    );
    expect(await simDialogs(page)).toEqual([]);
    await toast.locator('.jp-toast-button', { hasText: 'Grant' }).click();

    const result = await cli.done;
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(`${device.name}\n`);
    expect(await simDialogs(page)).toEqual([
      {
        kind: 'usb',
        options: {
          filters: [{ vendorId: device.vendorId, productId: device.productId }]
        },
        outcome: 'granted',
        device: device.id
      }
    ]);
    await expect(row(page, device.name)).toHaveAttribute('data-owner', 'this');
    expect(await usbRecord(device.name)).toMatchObject({ state: 'attached' });
    expect(await requestRecord(reason)).toMatchObject({
      state: 'granted',
      name: device.name
    });
    await expect(requestRow(page, reason)).toHaveCount(0);
    await expect(toast).toHaveCount(0);
  });

  test('ACC-USB-49 when the user cancels the dialog the request ends as denied and the CLI exits 1 with the reason', async ({
    page
  }) => {
    const device = simUsb();
    const reason = `update the firmware of ${device.name}`;
    const cancelled = { name: 'NotFoundError', message: 'No device selected.' };
    await openLab(page, { usb: [device], refuse: { usb: cancelled } });

    const cli = requestDevice(device, reason);
    const request = requestRow(page, reason);
    await whileRunning(
      cli,
      expect(request).toBeVisible({ timeout: ROUND_TRIP })
    );
    await action(request, 'grant').click();

    const result = await cli.done;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `the request was denied: ${cancelled.name}: ${cancelled.message}`
    );
    expect((await simDialogs(page)).map(dialog => dialog.outcome)).toEqual([
      'refused'
    ]);
    expect(await requestRecord(reason)).toMatchObject({
      state: 'denied',
      error: cancelled
    });
    expect(await usbRecord(device.name)).toBeUndefined();
    await expect(request).toHaveCount(0);
  });
});
