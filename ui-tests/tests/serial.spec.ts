import { expect, test } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';

import {
  action,
  addSerial,
  api,
  DEVICE_DIR,
  field,
  forget,
  getSetting,
  ISimCall,
  openLab,
  openSecondTab,
  PANEL_SHOWN,
  pickAddEntry,
  ROUND_TRIP,
  row,
  serialRecord,
  setSetting,
  showPanel,
  simAllowOpen,
  simArgs,
  simCalls,
  simDialogs,
  simGrants,
  simSerial,
  simUnplug,
  simWritten,
  startTool,
  toolReport
} from './helpers';

/**
 * Functional tests of a serial port: the real panel, worker, server and virtual serial
 * device, a simulated port in the browser (device-sim.js) and a real tool on the
 * device path (serial_tool.py). Ids in the titles are the criteria of
 * docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

const ALL_BYTES = Array.from({ length: 256 }, (_, value) => value);
const ALL_BYTES_HEX = Buffer.from(ALL_BYTES).toString('hex');
const BRIDGE_SOCKET = 'jupyterlab-device-bridge-extension/ws';
/** The settings of the default profile, as the worker passes them to `port.open()`. */
const MONITOR_OPEN = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  bufferSize: 65536,
  flowControl: 'none'
};

test.describe('serial port', () => {
  test('ACC-SERIAL-1 the entry Connect Serial Port of the plus menu opens the port dialog of the browser and the granted port is listed as attached', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    expect(await simDialogs(page)).toEqual([]);

    await addSerial(page, port);

    expect(await simDialogs(page)).toEqual([
      { kind: 'serial', options: null, outcome: 'granted', device: port.id }
    ]);
    const portRow = row(page, port.name);
    await expect(portRow).toHaveAttribute('data-kind', 'serial');
    await expect(field(portRow, 'state')).toHaveText('attached');
    expect(await serialRecord(port.name)).toMatchObject({
      state: 'attached',
      portState: 'open',
      path: `${DEVICE_DIR}/${port.name}`,
      vendorId: port.usbVendorId,
      productId: port.usbProductId
    });
    await expect
      .poll(() => simArgs(page, port.id, 'open'))
      .toEqual([[MONITOR_OPEN]]);
  });

  test('ACC-SERIAL-2 a port granted earlier is attached after a page load without a click', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const before = await serialRecord(port.name);

    await page.reload();

    // The tab of the new page holds the open port, and nothing was clicked.
    await expect
      .poll(
        async () => {
          const record = await serialRecord(port.name);
          return record.tab !== before.tab && record.portState;
        },
        { timeout: ROUND_TRIP }
      )
      .toBe('open');
    expect(await simDialogs(page)).toEqual([]);
    await expect
      .poll(() => simArgs(page, port.id, 'open'))
      .toEqual([[MONITOR_OPEN]]);
    expect((await serialRecord(port.name)).path).toBe(before.path);
    await showPanel(page);
    await expect(field(row(page, port.name), 'state')).toHaveText('attached');
  });

  test('ACC-SERIAL-5 all 256 byte values a tool writes to the virtual device reach the port in order', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);

    const tool = startTool(path, ['--write', ALL_BYTES_HEX, '--read', '256']);
    toolReport(await tool.done);

    await expect.poll(() => simWritten(page, port.id)).toEqual(ALL_BYTES);
  });

  test('ACC-SERIAL-6 all 256 byte values the port sends reach the tool that holds the virtual device in order', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);

    // The simulated port sends back every byte it gets.
    const tool = startTool(path, ['--write', ALL_BYTES_HEX, '--read', '256']);

    expect(toolReport(await tool.done).read).toEqual(ALL_BYTES);
  });

  test('ACC-SERIAL-9 the baud rate a tool sets on the virtual device is the baud rate the port is opened with', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);

    const tool = startTool(path, [
      '--baud',
      '57600',
      '--write',
      '55aa',
      '--read',
      '2'
    ]);
    expect(toolReport(await tool.done).read).toEqual([0x55, 0xaa]);

    // Each open of the port with its baud rate, and each byte written, in order: the
    // port is opened at 57600 for the tool's bytes and at the profile's rate after it.
    const opensAndBytes = async (): Promise<number[]> =>
      (await simCalls(page, port.id)).flatMap((call: ISimCall) => {
        if (call.op === 'open') {
          return [call.args[0].baudRate];
        }
        return call.op === 'write' ? call.args[0] : [];
      });
    await expect
      .poll(opensAndBytes, { timeout: ROUND_TRIP })
      .toEqual([115200, 57600, 0x55, 0xaa, 115200]);
  });

  test('ACC-SERIAL-14 the port streams and the WebSocket of the bridge live in a dedicated worker, not in the page', async ({
    page
  }) => {
    const port = simSerial();
    const isBridgeSocket = (call: ISimCall): boolean =>
      call.op === 'websocket' && call.args[0].includes(BRIDGE_SOCKET);
    const isPortOpen = (call: ISimCall): boolean =>
      call.device === port.id && call.op === 'open';
    /** Where every call of one sort was made: in the page or in a worker. */
    const realms = async (
      matches: (call: ISimCall) => boolean
    ): Promise<string[]> => [
      ...new Set((await simCalls(page)).filter(matches).map(call => call.realm))
    ];
    await openLab(page, { serial: [port] });

    // The page made the other WebSockets of the lab; a worker made the one to the bridge.
    await expect
      .poll(() => realms(isBridgeSocket), { timeout: ROUND_TRIP })
      .toEqual(['worker']);
    expect(await realms(call => call.op === 'websocket')).toContain('page');

    await addSerial(page, port);
    expect(await realms(isPortOpen)).toEqual(['worker']);

    // The same from the workers the browser lists for this page.
    const perWorker: ISimCall[][] = await Promise.all(
      page
        .workers()
        .map(worker =>
          worker.evaluate(() => (self as any).__deviceSim?.calls ?? [])
        )
    );
    expect(
      perWorker.filter(own => own.some(isBridgeSocket) && own.some(isPortOpen))
    ).toHaveLength(1);
  });

  test('ACC-SERIAL-16 an unplugged port is listed as removed, and its path stays', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);
    const portRow = row(page, port.name);

    await simUnplug(page, port.id);

    await expect(field(portRow, 'state')).toHaveText('removed', {
      timeout: ROUND_TRIP
    });
    // Nothing failed, so the row shows no error text.
    await expect(field(portRow, 'error')).toBeHidden();
    expect(await serialRecord(port.name)).toMatchObject({
      state: 'detached',
      tab: null,
      error: 'removed',
      path
    });
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
  });

  test('ACC-SERIAL-17 a port the browser cannot open shows the reason text of the browser in its row', async ({
    page
  }) => {
    const reason = 'Failed to open serial port.';
    const port = simSerial({
      openError: { name: 'NetworkError', message: reason }
    });
    await openLab(page, { serial: [port] });

    await pickAddEntry(page, 'serial');

    const error = field(row(page, port.name), 'error');
    await expect(error).toHaveText(reason, { timeout: ROUND_TRIP });
    await expect(error).toBeVisible();
    expect(await serialRecord(port.name)).toMatchObject({
      state: 'attached',
      portState: 'error',
      error: reason
    });
  });

  test('ACC-SERIAL-17 a port the browser could not open is opened again when a tool opens the device', async ({
    page
  }) => {
    const port = simSerial({
      openError: {
        name: 'NetworkError',
        message: 'Failed to open serial port.'
      }
    });
    await openLab(page, { serial: [port] });
    await pickAddEntry(page, 'serial');
    await expect
      .poll(() => serialRecord(port.name), { timeout: ROUND_TRIP })
      .toMatchObject({ state: 'attached', portState: 'error' });
    const { path } = await serialRecord(port.name);
    const opensBefore = (await simArgs(page, port.id, 'open')).length;

    // The cause of the failure ends, for example another program closed the port.
    await simAllowOpen(page, port.id);
    const tool = startTool(path, ['--write', '3020', '--read', '2']);
    toolReport(await tool.done);

    await expect
      .poll(() => serialRecord(port.name), { timeout: ROUND_TRIP })
      .toMatchObject({ portState: 'open', error: null });
    const opens = await simArgs(page, port.id, 'open');
    expect(opens.slice(opensBefore)).toEqual([[MONITOR_OPEN]]);
    expect(await simWritten(page, port.id)).toEqual([0x30, 0x20]);
  });

  test('ACC-SERIAL-18 detach closes the port and keeps the grant, and the device is listed as detached', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);
    const portRow = row(page, port.name);
    const operations = async (): Promise<string[]> =>
      (await simCalls(page, port.id)).map(call => call.op);

    await action(portRow, 'detach').click();

    await expect(field(portRow, 'state')).toHaveText('detached', {
      timeout: ROUND_TRIP
    });
    await expect.poll(operations).toEqual(['open', 'close']);
    expect(await simGrants(page)).toEqual([port.id]);
    expect(await serialRecord(port.name)).toMatchObject({
      state: 'detached',
      tab: null,
      path
    });

    // The grant stayed: Attach opens the port again and no dialog opens.
    await action(portRow, 'attach').click();
    await expect
      .poll(async () => (await serialRecord(port.name)).portState, {
        timeout: ROUND_TRIP
      })
      .toBe('open');
    await expect.poll(operations).toEqual(['open', 'close', 'open']);
    expect(await simDialogs(page)).toHaveLength(1);
  });

  test('ACC-SERIAL-19 forget revokes the grant and removes the device and its path', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    const portRow = row(page, port.name);

    await forget(portRow);

    await expect(portRow).toHaveCount(0, { timeout: ROUND_TRIP });
    await expect.poll(() => simGrants(page)).toEqual([]);
    expect(await simArgs(page, port.id, 'forget')).toHaveLength(1);
    expect(await serialRecord(port.name)).toBeUndefined();
    expect(fs.lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('ACC-SERIAL-19 forget in a second tab revokes the grant of that port only, when another port has the same ids', async ({
    page,
    baseURL
  }) => {
    // Two boards of one model have the same USB ids, and a serial port has no serial number.
    const port = simSerial();
    const twin = { ...port, id: `${port.id}-twin`, name: `${port.name}-2` };
    await openLab(page, { serial: [port, twin] });
    await addSerial(page, port);
    await addSerial(page, twin);
    const { tab } = await serialRecord(twin.name);

    // A second tab of the browser has both grants, and the first tab holds both ports.
    const second = await openSecondTab(page, baseURL, {
      serial: [port, twin]
    });
    await expect(row(second, twin.name)).toHaveAttribute(
      'data-owner',
      'other',
      { timeout: ROUND_TRIP }
    );

    // The first tab detaches one port, and the second tab forgets that port.
    await action(row(page, port.name), 'detach').click();
    const detached = row(second, port.name);
    await expect(field(detached, 'state')).toHaveText('detached', {
      timeout: ROUND_TRIP
    });
    await forget(detached);
    await expect(detached).toHaveCount(0, { timeout: ROUND_TRIP });

    // The other port keeps its grant, and the first tab still holds it.
    await expect.poll(() => simGrants(page)).toEqual([twin.id]);
    expect(await simArgs(page, port.id, 'forget')).toHaveLength(1);
    expect(await simArgs(page, twin.id, 'forget')).toEqual([]);
    expect(await serialRecord(twin.name)).toMatchObject({
      state: 'attached',
      portState: 'open',
      tab
    });
    await second.close();
  });

  test('ACC-PROF-31 a tool without the shim whose DTR call is refused still exchanges bytes with the port and gets the action of the profile', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const profile = await api('PUT', `serial/${port.name}/profile`, {
      profile: 'arduino-upload'
    });
    expect(profile.status).toBe(200);

    const tool = startTool(profile.body.path, [
      '--signals',
      'dtr=0',
      '--write',
      '3020',
      '--read',
      '2'
    ]);
    const report = toolReport(await tool.done);

    // A pty has no modem lines: the DTR call of the tool itself is refused.
    expect(report.signals).toEqual(['ENOTTY']);
    expect(report.read).toEqual([0x30, 0x20]);
    // The profile pulsed DTR when the tool opened the device, before the tool's bytes.
    const signalsAndBytes = async (): Promise<unknown[]> =>
      (await simCalls(page, port.id))
        .filter(call => call.op === 'setSignals' || call.op === 'write')
        .map(call => call.args[0]);
    await expect
      .poll(signalsAndBytes)
      .toEqual([
        { dataTerminalReady: false },
        { dataTerminalReady: true },
        [0x30, 0x20]
      ]);
  });
});

test.describe('default serial settings', () => {
  /**
   * The values of the Settings dialog of the row of a serial port: Settings opens the
   * dialog, Cancel closes it again.
   */
  async function editorValues(page: Page, portRow: Locator): Promise<string[]> {
    await action(portRow, 'settings').click();
    const dialog = page.locator('.jp-Dialog');
    const values = await Promise.all(
      ['baudRate', 'dataBits', 'parity', 'stopBits', 'onOpen'].map(name =>
        dialog.locator(`[data-profile-field="${name}"]`).inputValue()
      )
    );
    await dialog
      .locator('.jp-Dialog-button')
      .filter({ hasText: 'Cancel' })
      .click();
    await expect(dialog).toHaveCount(0);
    return values;
  }

  test('ACC-PROF-118 a serial port added after the default settings were set to 9600 baud, 7 data bits, even parity, 2 stop bits and pulse-dtr is opened with them, and its row and its record show them', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    const defaults = {
      baudRate: 9600,
      dataBits: 7,
      parity: 'even',
      stopBits: 2,
      onOpen: 'pulse-dtr'
    };
    await setSetting(page, 'defaultBaudRate', defaults.baudRate);
    await setSetting(page, 'defaultDataBits', defaults.dataBits);
    await setSetting(page, 'defaultParity', defaults.parity);
    await setSetting(page, 'defaultStopBits', defaults.stopBits);
    await setSetting(page, 'defaultOnOpen', defaults.onOpen);

    await addSerial(page, port);

    // The tab opened the port once, with the default settings.
    await expect
      .poll(() => simArgs(page, port.id, 'open'))
      .toEqual([
        [
          {
            ...MONITOR_OPEN,
            baudRate: 9600,
            dataBits: 7,
            parity: 'even',
            stopBits: 2
          }
        ]
      ]);
    expect(await serialRecord(port.name)).toMatchObject({
      profile: 'monitor',
      overrides: defaults,
      settings: { baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 2 }
    });
    const portRow = row(page, port.name);
    await expect(field(portRow, 'baud')).toHaveText('9600');
    await expect(field(portRow, 'profile')).toHaveText('monitor');
    expect(await editorValues(page, portRow)).toEqual([
      '9600',
      '7',
      'even',
      '2',
      'pulse-dtr'
    ]);

    // The default action on open runs when a tool opens the device: DTR is pulsed.
    const { path } = await serialRecord(port.name);
    const tool = startTool(path, ['--baud', '9600', '--write', '00']);
    expect((await tool.done).code).toBe(0);
    await expect
      .poll(() => simArgs(page, port.id, 'setSignals'))
      .toEqual([[{ dataTerminalReady: false }], [{ dataTerminalReady: true }]]);
    expect(await simArgs(page, port.id, 'open')).toHaveLength(1);
  });

  test('ACC-PROF-123 the Settings Editor offers the choices of the four default settings by their titles, stores the value of a chosen title, and a port added after that gets these values', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await page.evaluate(async () => {
      await (window as any).jupyterapp.commands.execute('settingeditor:open', {
        query: 'Device Bridge'
      });
    });
    await page
      .locator('.jp-PluginList-entry')
      .filter({ hasText: 'Device Bridge' })
      .click();
    /** The select of one setting on the page of the Settings Editor. */
    const select = (setting: string): Locator =>
      page.locator(`.jp-SettingsPanel select[id$="plugin_${setting}"]`);
    const titles = (setting: string): Promise<string[]> =>
      select(setting).locator('option').allTextContents();
    const shown = (setting: string): Promise<string> =>
      select(setting).evaluate(
        (element: HTMLSelectElement) =>
          element.selectedOptions[0].textContent ?? ''
      );
    await expect(select('defaultOnOpen')).toBeVisible();

    // Each setting is a select, with the titles of the schema and the default chosen.
    expect(await titles('defaultDataBits')).toEqual(['7', '8']);
    expect(await titles('defaultParity')).toEqual(['None', 'Even', 'Odd']);
    expect(await titles('defaultStopBits')).toEqual(['1', '2']);
    expect(await titles('defaultOnOpen')).toEqual([
      'Do nothing',
      'Pulse DTR',
      'Pulse RTS',
      'Enter the ESP bootloader',
      'Open at 1200 baud and close'
    ]);
    expect(
      await Promise.all(
        [
          'defaultDataBits',
          'defaultParity',
          'defaultStopBits',
          'defaultOnOpen'
        ].map(shown)
      )
    ).toEqual(['8', 'None', '1', 'Do nothing']);

    // A chosen title is stored as its value: a number for the two integer settings.
    await select('defaultOnOpen').selectOption({ label: 'Pulse DTR' });
    await expect
      .poll(() => getSetting(page, 'defaultOnOpen'))
      .toBe('pulse-dtr');
    await select('defaultParity').selectOption({ label: 'Even' });
    await expect.poll(() => getSetting(page, 'defaultParity')).toBe('even');
    await select('defaultDataBits').selectOption({ label: '7' });
    await expect.poll(() => getSetting(page, 'defaultDataBits')).toBe(7);
    await select('defaultStopBits').selectOption({ label: '2' });
    await expect.poll(() => getSetting(page, 'defaultStopBits')).toBe(2);

    // The server takes the stored values: a port added now gets them.
    await addSerial(page, port);
    expect((await serialRecord(port.name)).overrides).toEqual({
      dataBits: 7,
      parity: 'even',
      stopBits: 2,
      onOpen: 'pulse-dtr'
    });
    await expect
      .poll(() => simArgs(page, port.id, 'open'))
      .toEqual([
        [{ ...MONITOR_OPEN, dataBits: 7, parity: 'even', stopBits: 2 }]
      ]);
  });

  test('ACC-PROF-119 a default baud rate that changes reaches a port added after the change, without a reload, and leaves the port added before it as it is', async ({
    page
  }) => {
    const first = simSerial();
    const second = simSerial();
    await openLab(page, { serial: [first, second] });
    await addSerial(page, first);
    await expect
      .poll(() => simArgs(page, first.id, 'open'))
      .toEqual([[MONITOR_OPEN]]);

    await setSetting(page, 'defaultBaudRate', 57600);
    await addSerial(page, second);

    await expect
      .poll(() => simArgs(page, second.id, 'open'))
      .toEqual([[{ ...MONITOR_OPEN, baudRate: 57600 }]]);
    expect(await serialRecord(second.name)).toMatchObject({
      profile: 'monitor',
      overrides: { baudRate: 57600 },
      settings: { baudRate: 57600, dataBits: 8, parity: 'none', stopBits: 1 }
    });
    await expect(field(row(page, second.name), 'baud')).toHaveText('57600');

    // The port added before the change: its record, its row and its open port are unchanged.
    const unchanged = {
      state: 'attached',
      portState: 'open',
      profile: 'monitor',
      overrides: {},
      settings: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 }
    };
    expect(await serialRecord(first.name)).toMatchObject(unchanged);
    await expect(field(row(page, first.name), 'baud')).toHaveText('115200');
    expect(await simArgs(page, first.id, 'open')).toEqual([[MONITOR_OPEN]]);
    expect(await simArgs(page, first.id, 'close')).toEqual([]);

    // After a page load the tab claims both ports with the changed default, and both
    // records keep their values.
    const before = await serialRecord(first.name);
    await page.reload();
    await expect
      .poll(
        async () => {
          const record = await serialRecord(first.name);
          return record.tab !== before.tab && record.portState;
        },
        { timeout: ROUND_TRIP }
      )
      .toBe('open');
    expect(await serialRecord(first.name)).toMatchObject(unchanged);
    expect((await serialRecord(second.name)).overrides).toEqual({
      baudRate: 57600
    });
    await expect
      .poll(() => simArgs(page, first.id, 'open'))
      .toEqual([[MONITOR_OPEN]]);
  });
});
