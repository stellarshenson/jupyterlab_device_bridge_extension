import { expect, IJupyterLabPageFixture, test } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import { basename, join } from 'path';

import {
  action,
  addIcon,
  addMenu,
  addMenuEntry,
  addSerial,
  addUsb,
  api,
  closeTerminals,
  DEVICE_DIR,
  endProcesses,
  field,
  forget,
  getSetting,
  IChild,
  ISimCall,
  ISimSerial,
  lampEvents,
  openLab,
  openSecondTab,
  PANEL,
  PANEL_SHOWN,
  PANEL_TAB,
  pickAddEntry,
  recordLamps,
  ROUND_TRIP,
  row,
  runCli,
  runPids,
  runRow,
  runsSection,
  serialRecord,
  setSetting,
  simArgs,
  simDialogs,
  simSend,
  simSerial,
  simStream,
  simulate,
  simUsb,
  simWritten,
  startCli,
  startTool,
  STATUS_ITEM,
  terminalText,
  toast,
  toolCommand,
  toolReport,
  usbRecord,
  whileRunning
} from './helpers';

/**
 * Functional tests of the Devices panel, the status bar item, the commands, the
 * Devices menu and the option that shows the panel: the real lab, worker and server,
 * with simulated devices in the browser (device-sim.js). The tests of the runs start
 * the real `jupyterlab-device run` as a child process and the real device shell in a
 * terminal of the lab. Ids in the titles are the criteria of
 * docs/acc-crit-device-bridge.md and the defects of docs/defects-device-bridge.md.
 */

// The lab starts a device shell and the serial terminal through the basic terminal
// extension: the server makes the terminal, and the lab opens it by its name. Galata
// answers the list of the terminals itself, from the terminals a page made, and the lab
// would not find that terminal in it. So the terminals API is the real one here, and
// each test ends the terminals of the server itself.
test.use({ autoGoto: false, terminals: null });
test.afterEach(closeTerminals);

const MENU = '#jp-mainmenu-devices';
const VIEW_MENU = '#jp-mainmenu-view';
const COMMANDS = {
  connectSerial: ['device-bridge:connect-serial', 'Connect Serial Port'],
  connectUsb: ['device-bridge:connect-usb', 'Connect USB Device'],
  openTerminal: ['device-bridge:open-terminal', 'Serial Terminal'],
  startRun: ['device-bridge:start-run', 'Device Shell'],
  showPanel: ['device-bridge:show-panel', 'Show Devices Panel']
};
/** How long a test waits for the lamps to show a stream of the port, which takes 1.2 s at most. */
const LAMP_WAIT = 5000;
/**
 * How long one flash of a lamp can take, in ms. A lamp is lit for 80 ms from each
 * event, and a timer of the page fires late under load.
 */
const FLASH_MIN = 60;
const FLASH_MAX = 250;
/** A terminal of the lab starts the command line, which starts a shell or a terminal program. */
const TERMINAL_START = 45000;
/** The class the lab gives a menu item whose command is toggled: the item shows a check mark. */
const TOGGLED = /(^|\s)lm-mod-toggled(\s|$)/;

/** The entry of the menu bar of the lab with this label. */
const menuBarEntry = (page: Page, label: string): Locator =>
  page.locator('#jp-MainMenu .lm-MenuBar-itemLabel').filter({
    hasText: new RegExp(`^${label}$`)
  });

/** Change the setting showMenu through the setting registry of the lab, as the Settings Editor does. */
const setShowMenu = (page: Page, show: boolean): Promise<void> =>
  setSetting(page, 'showMenu', show);

/** The item Show Devices Panel of the View menu; it is in the document while that menu is open. */
const viewItem = (page: Page): Locator =>
  page.locator(
    `${VIEW_MENU} .lm-Menu-item[data-command="${COMMANDS.showPanel[0]}"]`
  );

/** Open the View menu of the lab and return its item Show Devices Panel. */
async function openViewMenu(page: Page): Promise<Locator> {
  await menuBarEntry(page, 'View').click();
  const item = viewItem(page);
  // Visible means: in the open menu and not hidden by the lab. A click needs it enabled.
  await expect(item).toBeVisible();
  await expect(item).not.toHaveClass(/lm-mod-disabled/);
  return item;
}

/** Choose Show Devices Panel in the View menu, as the user does. */
async function chooseViewItem(page: Page): Promise<void> {
  await (await openViewMenu(page)).click();
  await expect(page.locator(VIEW_MENU)).toHaveCount(0);
}

/**
 * Wait until the lab has stored this value of the setting showPanel. The panel changes
 * at the click, and the lab saves the setting after that.
 */
const stored = (page: Page, value: boolean): Promise<void> =>
  expect.poll(() => getSetting(page, 'showPanel')).toBe(value);

/** Whether the item Show Devices Panel of the View menu has its check mark; the menu is closed again. */
async function viewItemMarked(page: Page): Promise<boolean> {
  const item = await openViewMenu(page);
  const marked = TOGGLED.test((await item.getAttribute('class')) ?? '');
  await page.keyboard.press('Escape');
  await expect(page.locator(VIEW_MENU)).toHaveCount(0);
  return marked;
}

/** Each change of a lamp of the row of a device so far: the lamp and whether it is lit after it. */
const lampChanges = async (
  page: Page,
  device: string
): Promise<Array<[string, boolean]>> =>
  (await lampEvents(page, device)).map(event => [event.lamp, event.lit]);

/** Run a command as the user does: search its label in the command palette and click it. */
async function runFromPalette(
  page: Page,
  [command, label]: string[]
): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute(
      'apputils:activate-command-palette'
    );
  });
  await page.locator('.lm-CommandPalette-input').fill(label);
  await page
    .locator(`.lm-CommandPalette-item[data-command="${command}"]`)
    .click();
}

test.describe('Devices panel', () => {
  test.use({ mockSettings: PANEL_SHOWN });

  test('ACC-SERIAL-15 the panel shows the measured browser to server round trip in milliseconds', async ({
    page
  }) => {
    await openLab(page, {});

    await expect(field(page.locator(PANEL), 'round-trip')).toHaveText(
      /^\d+\.\d ms$/,
      { timeout: ROUND_TRIP }
    );
  });

  test('ACC-PROF-23 parity, data bits, stop bits and the action on open of a serial port are set in the panel', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const portRow = row(page, port.name);
    const control = (name: string): Locator =>
      portRow.locator(`[data-profile-field="${name}"]`);
    /** The settings the simulated port was opened with the last time. */
    const openedWith = async (): Promise<unknown> =>
      (await simArgs(page, port.id, 'open')).at(-1)?.[0];
    await portRow.locator('summary').click();

    await control('profile').selectOption('stm32-bootloader');

    await expect(field(portRow, 'profile')).toHaveText('stm32-bootloader', {
      timeout: ROUND_TRIP
    });
    expect(await serialRecord(port.name)).toMatchObject({
      profile: 'stm32-bootloader',
      settings: { baudRate: 115200, dataBits: 8, parity: 'even', stopBits: 1 }
    });
    await expect
      .poll(openedWith, { timeout: ROUND_TRIP })
      .toMatchObject({ dataBits: 8, parity: 'even', stopBits: 1 });

    // Each single field of the editor.
    await control('parity').selectOption('odd');
    await control('dataBits').selectOption('7');
    await control('stopBits').selectOption('2');
    await control('onOpen').selectOption('pulse-rts');

    await expect
      .poll(async () => (await serialRecord(port.name)).overrides, {
        timeout: ROUND_TRIP
      })
      .toEqual({
        parity: 'odd',
        dataBits: 7,
        stopBits: 2,
        onOpen: 'pulse-rts'
      });
    await expect
      .poll(openedWith, { timeout: ROUND_TRIP })
      .toMatchObject({ dataBits: 7, parity: 'odd', stopBits: 2 });

    // The action on open runs when a tool opens the device: RTS is pulsed.
    const { path } = await serialRecord(port.name);
    const tool = startTool(path, ['--write', '00', '--read', '1']);
    expect((await tool.done).code).toBe(0);
    await expect
      .poll(() => simArgs(page, port.id, 'setSignals'))
      .toEqual([[{ requestToSend: false }], [{ requestToSend: true }]]);
  });

  test('ACC-PROF-23 an arrow key in the baud rate field of the panel changes no baud rate', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const portRow = row(page, port.name);
    const control = (name: string): Locator =>
      portRow.locator(`[data-profile-field="${name}"]`);
    await portRow.locator('summary').click();

    // DEF-PANEL-6: a number field takes the key as a step of 1, and the panel sends it.
    await control('baudRate').focus();
    await page.keyboard.press('ArrowUp');

    await expect(control('baudRate')).toHaveValue('115200');
    // A change of the baud rate would reach the server before this change of the parity.
    await control('parity').selectOption('even');
    await expect
      .poll(async () => (await serialRecord(port.name)).overrides, {
        timeout: ROUND_TRIP
      })
      .toEqual({ parity: 'even' });
  });

  test('ACC-PANEL-64 the panel lists every attached device with kind, name, state, holding program, and for a serial port baud rate and profile', async ({
    page
  }) => {
    const port = simSerial();
    const device = simUsb();
    await openLab(page, { serial: [port], usb: [device] });
    await addSerial(page, port);
    await addUsb(page, device);
    const portRow = row(page, port.name);
    const deviceRow = row(page, device.name);
    await expect(field(portRow, 'holder')).toHaveText('none');

    // A tool holds the virtual device, open at its own baud rate.
    const { path } = await serialRecord(port.name);
    const tool = startTool(path, ['--baud', '19200', '--hold']);
    await tool.firstLine;
    await expect
      .poll(async () => (await serialRecord(port.name)).holder?.pid, {
        timeout: ROUND_TRIP
      })
      .toBe(tool.process.pid);
    const { holder } = await serialRecord(port.name);
    expect(holder.name).toMatch(/^python/);

    await expect(field(portRow, 'kind')).toHaveText('Serial');
    await expect(field(portRow, 'name')).toHaveText(port.name);
    await expect(field(portRow, 'state')).toHaveText('attached');
    await expect(field(portRow, 'holder')).toHaveText(
      `${holder.name} (pid ${tool.process.pid})`
    );
    await expect(field(portRow, 'baud')).toHaveText('19200');
    await expect(field(portRow, 'profile')).toHaveText('monitor');

    await expect(field(deviceRow, 'kind')).toHaveText('USB');
    await expect(field(deviceRow, 'name')).toHaveText(device.name);
    await expect(field(deviceRow, 'state')).toHaveText('attached');
    await expect(field(deviceRow, 'product')).toHaveText(
      `${device.manufacturerName} ${device.productName}`
    );
    await expect(field(deviceRow, 'holder')).toHaveText('none');

    // A program opens the USB device: its row names the program.
    const opened = await runCli(['usb', 'open', device.name]);
    expect(opened.code, `stderr: ${opened.stderr}`).toBe(0);
    await expect(field(deviceRow, 'holder')).toHaveText('jupyterlab-device', {
      timeout: ROUND_TRIP
    });

    // The tool ends: the row shows no program and the baud rate of the profile.
    tool.process.stdin!.write('\n');
    expect((await tool.done).code).toBe(0);
    await expect(field(portRow, 'holder')).toHaveText('none', {
      timeout: ROUND_TRIP
    });
    await expect(field(portRow, 'baud')).toHaveText('115200');
  });

  test('ACC-PANEL-65 each row shows byte counters that grow with traffic', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const portRow = row(page, port.name);
    await expect(field(portRow, 'rx')).toHaveText('0');
    await expect(field(portRow, 'tx')).toHaveText('0');

    // 4 bytes to the port through the server; the simulated port sends them back.
    const written = await api('POST', `serial/${port.name}/write`, {
      data: Buffer.from('ping').toString('base64')
    });
    expect(written.status).toBe(200);
    await expect(field(portRow, 'tx')).toHaveText('4', { timeout: ROUND_TRIP });
    await expect(field(portRow, 'rx')).toHaveText('4', { timeout: ROUND_TRIP });

    // 3 bytes that the port sends on its own count as received only.
    await simSend(page, port.id, [1, 2, 3]);
    await expect(field(portRow, 'rx')).toHaveText('7', { timeout: ROUND_TRIP });
    await expect(field(portRow, 'tx')).toHaveText('4');
  });

  test('ACC-PANEL-138 bursts of bytes from the port 400 ms apart flash the RX lamp once each, bytes to the port flash the TX lamp, and a larger counter in the device table lights no lamp of a port this tab holds', async ({
    page
  }) => {
    // The port does not send back what it gets: each direction has traffic of its own.
    const port = simSerial({ echo: false });
    await recordLamps(page);
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const portRow = row(page, port.name);
    const lamp = (name: string): Locator =>
      portRow.locator(`[data-lamp="${name}"]`);
    const changes = (): Promise<Array<[string, boolean]>> =>
      lampChanges(page, port.name);

    await expect(lamp('tx')).toHaveText('TX');
    await expect(lamp('tx')).toHaveAttribute('title', 'bytes to the device');
    await expect(lamp('rx')).toHaveText('RX');
    await expect(lamp('rx')).toHaveAttribute('title', 'bytes from the device');
    // The row is new: no lamp was lit, and none is.
    expect(await changes()).toEqual([]);
    await expect(portRow.locator('[data-lit]')).toHaveCount(0);

    // 3 bursts of 3 bytes from the port: the RX lamp flashes 3 times, the TX lamp stays off.
    await simStream(page, port.id, [1, 2, 3], 3, 400);
    const flashes: Array<[string, boolean]> = [
      ['rx', true],
      ['rx', false],
      ['rx', true],
      ['rx', false],
      ['rx', true],
      ['rx', false]
    ];
    await expect.poll(changes, { timeout: LAMP_WAIT }).toEqual(flashes);
    // The server gets the byte counters once a second. The device table that carries
    // the larger counter lights nothing.
    await expect(field(portRow, 'rx')).toHaveText('9', { timeout: ROUND_TRIP });
    expect(await changes()).toEqual(flashes);

    // 4 bytes to the port through the server: the TX lamp flashes once.
    const written = await api('POST', `serial/${port.name}/write`, {
      data: Buffer.from('ping').toString('base64')
    });
    expect(written.status).toBe(200);
    flashes.push(['tx', true], ['tx', false]);
    await expect.poll(changes, { timeout: LAMP_WAIT }).toEqual(flashes);
    await expect(field(portRow, 'tx')).toHaveText('4', { timeout: ROUND_TRIP });
    expect(await changes()).toEqual(flashes);

    const events = await lampEvents(page, port.name);
    for (let index = 0; index < events.length; index += 2) {
      const [on, off] = [events[index], events[index + 1]];
      expect(off.at - on.at).toBeGreaterThan(FLASH_MIN);
      expect(off.at - on.at).toBeLessThan(FLASH_MAX);
      // The circle of a lit lamp has another colour than the circle of a lamp that is off.
      expect(on.colour).not.toBe(off.colour);
    }
    // The RX lamp was off between its flashes: about 320 ms each time.
    for (const next of [2, 4]) {
      expect(events[next].at - events[next - 1].at).toBeGreaterThan(100);
    }
    await expect(portRow.locator('[data-lit]')).toHaveCount(0);
  });

  test('ACC-PANEL-138 a steady stream of bytes from the port keeps the RX lamp lit without a break until the stream ends', async ({
    page
  }) => {
    const port = simSerial({ echo: false });
    await recordLamps(page);
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const portRow = row(page, port.name);
    const steady: Array<[string, boolean]> = [
      ['rx', true],
      ['rx', false]
    ];

    // One byte every 20 ms for 1.2 s: each 50 ms period of the worker has bytes.
    await simStream(page, port.id, [0x55], 60, 20);

    await expect
      .poll(() => lampChanges(page, port.name), { timeout: LAMP_WAIT })
      .toEqual(steady);
    // Lit from the first period with bytes until 80 ms after the last one.
    const [on, off] = await lampEvents(page, port.name);
    expect(off.at - on.at).toBeGreaterThan(1000);
    expect(off.at - on.at).toBeLessThan(2500);
    // The device table with the 60 bytes counted comes within a second, and it lights nothing.
    await expect(field(portRow, 'rx')).toHaveText('60', {
      timeout: ROUND_TRIP
    });
    expect(await lampChanges(page, port.name)).toEqual(steady);
    await expect(portRow.locator('[data-lit]')).toHaveCount(0);
  });

  test('ACC-PANEL-138 the row of a port that another tab holds appears with no lit lamp, and a larger counter in the device table flashes its RX lamp', async ({
    page,
    baseURL
  }) => {
    const port = simSerial({ echo: false });
    // In every page of the browser, so in the second tab too.
    await recordLamps(page.context());
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    await simSend(page, port.id, [1, 2, 3]);
    await expect
      .poll(async () => (await serialRecord(port.name)).rx, {
        timeout: ROUND_TRIP
      })
      .toBe(3);

    // A second tab: the first device table it gets has this port with 3 bytes counted.
    const second = await openSecondTab(page, baseURL, { serial: [port] });
    const other = row(second, port.name);
    await expect(other).toHaveAttribute('data-owner', 'other', {
      timeout: ROUND_TRIP
    });
    await expect(field(other, 'rx')).toHaveText('3');
    expect(await lampChanges(second, port.name)).toEqual([]);
    await expect(other.locator('[data-lit]')).toHaveCount(0);

    // The port sends 2 bytes more. The second tab moves no byte of this port: it
    // learns of them from the device table, and that table flashes the lamp.
    await simSend(page, port.id, [4, 5]);
    await expect(field(other, 'rx')).toHaveText('5', { timeout: ROUND_TRIP });
    await expect
      .poll(() => lampChanges(second, port.name), { timeout: LAMP_WAIT })
      .toEqual([
        ['rx', true],
        ['rx', false]
      ]);
    const [on, off] = await lampEvents(second, port.name);
    expect(off.at - on.at).toBeGreaterThan(FLASH_MIN);
    expect(off.at - on.at).toBeLessThan(FLASH_MAX);
    await second.close();
  });

  test('DEF-PANEL-14 at the width the lab gives the left sidebar no section title of the panel is cut, and the devices section reads Serial and USB devices', async ({
    page
  }) => {
    // A port and a device request of a program: each of the three sections is shown.
    // The dialog of the request offers no device, which ends the request as denied.
    const port = simSerial();
    const reason = `read the titles beside ${port.name}`;
    await openLab(page, {
      serial: [port],
      refuse: { usb: { name: 'NotFoundError', message: 'No device selected.' } }
    });
    await addSerial(page, port);
    const request = startCli([
      ...['request', 'usb', '--reason', reason, '--timeout', '40']
    ]);
    request.process.stdin!.end();
    const requestRow = page
      .locator(`${PANEL} [data-section="requests"] [data-request]`)
      .filter({ hasText: reason });
    await whileRunning(
      request,
      expect(requestRow).toBeVisible({ timeout: ROUND_TRIP })
    );

    const panel = page.locator(PANEL);
    expect((await panel.boundingBox())!.width).toBe(250);
    /** The title of each section that is shown: its text, and its width as needed and as given. */
    const titles = await panel.locator('[data-section]').evaluateAll(sections =>
      sections
        .filter(section => (section as HTMLElement).offsetParent !== null)
        .map(section => {
          const title = section.querySelector<HTMLElement>(
            '.jp-DeviceBridgePanel-sectionTitle'
          )!;
          return {
            section: section.getAttribute('data-section'),
            text: title.textContent,
            needs: title.scrollWidth,
            has: title.clientWidth
          };
        })
    );
    expect(titles.map(title => [title.section, title.text]).sort()).toEqual([
      ['devices', 'Serial and USB devices'],
      ['requests', 'Requests of programs'],
      ['runs', 'Device shell and tools']
    ]);
    for (const title of titles) {
      // A title that is cut needs more width than it has.
      expect(title.has, title.text ?? '').toBeGreaterThan(0);
      expect(title.needs, title.text ?? '').toBeLessThanOrEqual(title.has);
    }

    await action(requestRow, 'grant').click();
    expect((await request.done).code).toBe(1);
    await expect(requestRow).toHaveCount(0);
  });

  test('ACC-PANEL-66 the status bar item is visible while a device is attached and absent when none is', async ({
    page
  }) => {
    const port = simSerial();
    const status = page.locator(STATUS_ITEM);
    await openLab(page, { serial: [port] });
    // A positive control of the locator of the status bar, then our item is not shown.
    await expect(page.locator('#jp-main-statusbar')).toBeVisible();
    await expect(status).toBeHidden();

    await addSerial(page, port);
    await expect(status).toBeVisible();
    await expect(field(status, 'count')).toHaveText('1');

    await forget(row(page, port.name));
    await expect(status).toBeHidden({ timeout: ROUND_TRIP });
    expect(await serialRecord(port.name)).toBeUndefined();
  });

  test('ACC-PANEL-153 the header of the panel has one plus icon and the panel has no add button; a click opens a menu under the icon with the entries Connect Serial Port and Connect USB Device; each entry opens the dialog of the browser, and the granted device is listed as attached', async ({
    page
  }) => {
    const port = simSerial();
    const device = simUsb();
    await openLab(page, { serial: [port], usb: [device] });
    const panel = page.locator(PANEL);
    const icon = panel.locator(
      '.jp-DeviceBridgePanel-header button[data-action="add-device"]'
    );
    await expect(icon).toHaveCount(1);
    await expect(panel.locator('[data-action="add-device"]')).toHaveCount(1);
    await expect(icon).toBeEnabled();
    await expect(icon.locator('svg')).toHaveCount(1);
    // The two add buttons of the first version are gone. Start is a positive control
    // of this way to find a button of the panel.
    await expect(action(panel, 'start-run')).toHaveCount(1);
    await expect(
      panel.locator(
        '[data-action="connect-serial"], [data-action="connect-usb"]'
      )
    ).toHaveCount(0);

    await icon.click();

    const menu = addMenu(page);
    await expect(menu).toBeVisible();
    await expect(menu.locator('.lm-Menu-itemLabel')).toHaveText([
      'Connect Serial Port',
      'Connect USB Device'
    ]);
    expect(
      await menu
        .locator('.lm-Menu-item')
        .evaluateAll(items =>
          items.map(item => item.getAttribute('data-command'))
        )
    ).toEqual(['device-bridge:connect-serial', 'device-bridge:connect-usb']);
    // The menu is below the icon, the left edges in one line.
    const iconBox = (await icon.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(Math.abs(menuBox.x - iconBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(menuBox.y - (iconBox.y + iconBox.height))
    ).toBeLessThanOrEqual(1);

    // Each entry opens the dialog of the browser, and the device it grants is attached.
    expect(await simDialogs(page)).toEqual([]);
    await addMenuEntry(page, 'serial').click();
    await expect(menu).toHaveCount(0);
    await expect
      .poll(async () => (await serialRecord(port.name))?.portState, {
        timeout: ROUND_TRIP
      })
      .toBe('open');
    await expect(field(row(page, port.name), 'state')).toHaveText('attached');

    await icon.click();
    await addMenuEntry(page, 'usb').click();
    await expect
      .poll(async () => (await usbRecord(device.name))?.state, {
        timeout: ROUND_TRIP
      })
      .toBe('attached');
    await expect(field(row(page, device.name), 'state')).toHaveText('attached');
    expect(
      (await simDialogs(page)).map(dialog => [
        dialog.kind,
        dialog.outcome,
        dialog.device
      ])
    ).toEqual([
      ['serial', 'granted', port.id],
      ['usb', 'granted', device.id]
    ]);
  });

  test('ACC-PANEL-154 when the browser has neither interface the panel names HTTPS and localhost, and the plus icon is disabled, dimmed and opens no menu', async ({
    page
  }) => {
    await openLab(page, { absent: true });
    const panel = page.locator(PANEL);

    const absent = field(panel, 'absent');
    await expect(absent).toBeVisible();
    await expect(absent).toContainText('HTTPS');
    await expect(absent).toContainText('localhost');
    const icon = addIcon(page);
    await expect(icon).toHaveCount(1);
    await expect(icon).toBeDisabled();
    await expect(icon).toHaveCSS('opacity', '0.4');
    // A click on the place of a disabled icon opens nothing.
    await icon.click({ force: true });
    await expect(addMenu(page)).toHaveCount(0);
  });

  test('ACC-PANEL-155 the plus icon has the measures of an icon button: 24 px by 24 px, a glyph of 14 px, no border and a transparent background, and under the pointer the background --jp-layout-color3', async ({
    page
  }) => {
    await openLab(page, {});
    const icon = addIcon(page);
    // The pointer is somewhere else: the icon is in its plain state.
    await page.mouse.move(700, 500);
    await expect(icon).toHaveCSS('width', '24px');
    await expect(icon).toHaveCSS('height', '24px');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      await expect(icon).toHaveCSS(`border-${side}-width`, '0px');
    }
    await expect(icon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const glyph = icon.locator('svg');
    await expect(glyph).toHaveCSS('width', '14px');
    await expect(glyph).toHaveCSS('height', '14px');

    // What the variable of the lab is on the panel, as the colour the browser computes.
    const layoutColor3 = await page.locator(PANEL).evaluate(panel => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--jp-layout-color3)';
      panel.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
    expect(layoutColor3).toMatch(/^rgb\(/);
    await icon.hover();
    await expect(icon).toHaveCSS('background-color', layoutColor3);
  });

  test('ACC-PANEL-156 with the focus on the plus icon Enter opens the menu, ArrowDown and Enter pick the entry of the serial port, and Escape closes the menu with the focus on the icon again; the title of the icon says what it adds', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    const icon = addIcon(page);
    const menu = addMenu(page);
    await expect(icon).toHaveAttribute(
      'title',
      'Add a serial port or a USB device'
    );
    await expect(icon).toHaveAttribute('aria-haspopup', 'menu');

    await icon.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.lm-Menu-item.lm-mod-active')).toHaveAttribute(
      'data-command',
      'device-bridge:connect-serial'
    );
    await page.keyboard.press('Enter');

    // The key is a user gesture: the dialog of the browser opened and gave the port.
    await expect(menu).toHaveCount(0);
    await expect
      .poll(async () => (await serialRecord(port.name))?.portState, {
        timeout: ROUND_TRIP
      })
      .toBe('open');
    await expect(field(row(page, port.name), 'state')).toHaveText('attached');
    expect((await simDialogs(page)).map(dialog => dialog.outcome)).toEqual([
      'granted'
    ]);

    await icon.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(icon).toBeFocused();
    // Escape picked nothing: no second dialog opened.
    expect(await simDialogs(page)).toHaveLength(1);
  });

  test('ACC-PANEL-71 a second lab tab shows a device of the first tab as held by another tab, with no detach and no forget', async ({
    page,
    baseURL
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const first = await serialRecord(port.name);

    // A second tab of the same browser: it has the same grant, as with Chrome.
    const second = await openSecondTab(page, baseURL, { serial: [port] });

    const other = row(second, port.name);
    await expect(other).toHaveAttribute('data-owner', 'other', {
      timeout: ROUND_TRIP
    });
    await expect(field(other, 'state')).toHaveText('held by another tab');
    await expect(action(other, 'detach')).toBeHidden();
    await expect(action(other, 'forget')).toBeHidden();
    // The same buttons exist and show in the tab that holds the port.
    await expect(action(row(page, port.name), 'detach')).toBeVisible();
    await expect(action(row(page, port.name), 'forget')).toBeVisible();

    // The first tab still holds the port, and the worker of the second tab did not open it.
    expect(await serialRecord(port.name)).toMatchObject({
      state: 'attached',
      tab: first.tab
    });
    const opened: ISimCall[][] = await Promise.all(
      second
        .workers()
        .map(worker =>
          worker.evaluate(() =>
            ((self as any).__deviceSim?.calls ?? []).filter(
              (call: ISimCall) => call.op === 'open'
            )
          )
        )
    );
    expect(opened.flat()).toEqual([]);
    await second.close();
  });

  test('DEF-PANEL-11 a dialog the browser refuses displays an error toast with the reason of the browser', async ({
    page
  }) => {
    await openLab(page, {
      refuse: {
        serial: { name: 'NetworkError', message: 'The port is in use.' }
      }
    });

    await pickAddEntry(page, 'serial');

    await expect(
      toast(page, 'No device was attached: The port is in use.')
    ).toBeVisible();
    expect((await simDialogs(page)).map(dialog => dialog.outcome)).toEqual([
      'refused'
    ]);
  });

  test('DEF-SERIAL-12 a baud rate above 4294967295 is refused: the lab does not save it as a default, and for a port the server refuses it with a reason that the lab displays as a toast', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    // The setting registry checks a value against the schema before it saves.
    await expect(
      setSetting(page, 'defaultBaudRate', 4294967296)
    ).rejects.toThrow();
    expect(await getSetting(page, 'defaultBaudRate')).toBe(115200);

    await addSerial(page, port);
    const portRow = row(page, port.name);
    const control = (name: string): Locator =>
      portRow.locator(`[data-profile-field="${name}"]`);
    await portRow.locator('summary').click();
    await control('baudRate').fill('4294967296');
    await control('baudRate').press('Enter');

    // DEF-PANEL-11: the reason of the server is displayed, not only listed.
    await expect(
      toast(
        page,
        `The profile of ${port.name} was not changed: baudRate: 4294967296 is not a whole number from 1 to 4294967295`
      )
    ).toBeVisible();
    await expect(control('baudRate')).toHaveValue('115200');
  });
});

test.describe('Device shell and tools', () => {
  test.use({ mockSettings: PANEL_SHOWN });

  const EMPTY =
    'No device shell is open. Start opens a terminal in which tools control the lines of the serial ports.';
  /** The line of the banner of a device shell that was started while no device was attached. */
  const NO_DEVICE = 'No device is attached.';
  /**
   * The lines of the banner about the upload tools. The banner names the known tools
   * that the PATH of the test server holds, which is the PATH of the suite.
   */
  const TOOLS = ['avrdude', 'stm32flash', 'esptool'].filter(tool =>
    (process.env.PATH ?? '').split(':').some(folder => {
      try {
        fs.accessSync(join(folder, tool), fs.constants.X_OK);
        return fs.statSync(join(folder, tool)).isFile();
      } catch {
        return false;
      }
    })
  );
  const TOOL_LINES =
    TOOLS.length > 0
      ? [`For ${TOOLS.join(', ')}.`]
      : [
          'No avrdude, stm32flash or esptool on PATH.',
          'Install one to make use of the device shell.'
        ];

  /** The processes the test started. Each is ended when the test ends, also when it failed. */
  let started: number[];
  test.beforeEach(() => {
    started = [];
  });
  // The terminals are ended before this, and a shell in a terminal ends with it.
  test.afterEach(() => endProcesses(started));

  /** Start `jupyterlab-device run` as a child process of the test, as an agent starts a tool. */
  function startRun(args: string[]): IChild & { pid: number } {
    const child = startCli(['run', ...args]);
    const pid = child.process.pid as number;
    started.push(pid);
    return { ...child, pid };
  }

  /** The row of a run of a child process, once the panel lists it. */
  async function listed(page: Page, run: IChild & { pid: number }) {
    const rowOfRun = runRow(page, run.pid);
    await whileRunning(
      run,
      expect(rowOfRun).toBeVisible({ timeout: ROUND_TRIP })
    );
    return rowOfRun;
  }

  /**
   * The colour that the terminal draws the banner in, read from the diamond that starts
   * its second line, as 0xRRGGBB; null when the terminal has no such colour for it.
   */
  const bannerColour = (page: Page): Promise<number | null> =>
    page.evaluate(() => {
      for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
        const buffer = widget.content?._term?.buffer.active;
        for (let index = 0; buffer && index < buffer.length; index++) {
          const row = buffer.getLine(index);
          const at = row.translateToString(true).indexOf('◆');
          if (at >= 0) {
            const cell = row.getCell(at);
            return cell.isFgRGB() ? cell.getFgColor() : null;
          }
        }
      }
      return null;
    });

  /**
   * The text of the banner in the lab terminal: its lines from the name line, which
   * starts with the diamond, to the rule that ends the banner.
   */
  const bannerText = async (page: Page): Promise<string[]> => {
    const lines = (await terminalText(page)).split('\n');
    const first = lines.findIndex(line => line.startsWith('◆'));
    const rule = lines.findIndex(
      (line, index) => index > first && /^─+$/.test(line)
    );
    return first < 0 || rule < 0 ? [] : lines.slice(first, rule);
  };

  /**
   * Start a device shell in a terminal of the lab and wait until the panel lists it.
   *
   * @param start What the user does: the click or the command that opens the terminal
   * @param devices The lines of the banner for the attached devices
   * @returns The process id of the run, which is the shell
   */
  async function startShell(
    page: Page,
    start: () => Promise<void>,
    devices = [NO_DEVICE]
  ): Promise<number> {
    const rows = runsSection(page).locator('[data-run]');
    // The server ends the run of an earlier test within a second after its process ended.
    await expect.poll(runPids).toEqual([]);
    await expect(rows).toHaveCount(0);
    await expect(page.locator('.jp-Terminal')).toHaveCount(0);

    await start();

    await expect(page.locator('.jp-Terminal')).toHaveCount(1, {
      timeout: TERMINAL_START
    });
    // The banner is whole when the terminal shows the rule that ends it.
    await expect
      .poll(async () => (await bannerText(page)).length, {
        timeout: TERMINAL_START
      })
      .toBeGreaterThan(0);
    // The first text of the terminal is the banner: the two rows of its wave, then its
    // name line. The lab typed no command line: the terminal started the shell itself.
    const lines = (await terminalText(page)).split('\n');
    expect(lines[0] + lines[1]).toMatch(/^[─┐┌└┘ ]+$/);
    expect(lines[2]).toMatch(/^◆ /);
    expect(lines.join('\n')).not.toContain('jupyterlab-device shell');
    // The banner is pale cyan (ACC-SHIM-136). It names a device shell (ACC-PANEL-140),
    // the upload tools on PATH (ACC-SHIM-142), the attached devices and no other
    // device (ACC-SHIM-139) and two commands (ACC-CLI-141). No line holds the word shim.
    expect(await bannerColour(page)).toBe(0x9fe0ee);
    const banner = await bannerText(page);
    expect(banner).toEqual([
      expect.stringMatching(/^◆ jupyterlab-device +device shell$/),
      '',
      ...TOOL_LINES,
      ...devices,
      '',
      expect.stringMatching(/^jupyterlab-device list +all devices$/),
      expect.stringMatching(/^jupyterlab-device help +example commands$/)
    ]);
    expect(banner.join('\n')).not.toMatch(/shim/i);

    // The shell registered itself as a run under its own name, not under the name of
    // the shell command of the lab.
    await expect(rows).toHaveCount(1, { timeout: ROUND_TRIP });
    const pid = Number(await rows.getAttribute('data-run'));
    started.push(pid);
    const shellRow = runRow(page, pid);
    await expect(field(shellRow, 'program')).toHaveText('jupyterlab-device');
    await expect(field(shellRow, 'pid')).toHaveText(`pid ${pid}`);
    await expect(field(shellRow, 'command')).toHaveText(
      'jupyterlab-device shell'
    );
    await expect(field(shellRow, 'device')).toHaveText('no device');
    return pid;
  }

  test('ACC-PANEL-131 a program started with jupyterlab-device run is listed with its program, process id and command line, and with the serial port it holds as its device', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const section = runsSection(page);
    await expect(section).toContainText('Device shell and tools');
    await expect(field(section, 'count')).toHaveText('(0)');
    await expect(field(section, 'empty')).toBeVisible();
    await expect(field(section, 'empty')).toHaveText(EMPTY);

    // A tool that opens the virtual device and holds it until a line arrives on stdin.
    const { path: devicePath } = await serialRecord(port.name);
    const command = toolCommand(devicePath, ['--hold']);
    const run = startRun(['--', ...command]);

    const rowOfRun = await listed(page, run);
    await expect(field(rowOfRun, 'program')).toHaveText(basename(command[0]));
    await expect(field(rowOfRun, 'pid')).toHaveText(`pid ${run.pid}`);
    // The server cuts a command line after 200 characters.
    await expect(field(rowOfRun, 'command')).toHaveText(
      command.join(' ').slice(0, 200)
    );
    // The run named no device: its device is the port that its process holds.
    await expect
      .poll(async () => (await serialRecord(port.name)).holder?.pid, {
        timeout: ROUND_TRIP
      })
      .toBe(run.pid);
    await expect(field(rowOfRun, 'device')).toHaveText(port.name, {
      timeout: ROUND_TRIP
    });
    await expect(field(section, 'count')).toHaveText('(1)');
    await expect(field(section, 'empty')).toBeHidden();

    // The tool ends: its row leaves the panel.
    run.process.stdin!.write('\n');
    expect((await run.done).code).toBe(0);
    await expect(rowOfRun).toHaveCount(0, { timeout: ROUND_TRIP });
    await expect(field(section, 'count')).toHaveText('(0)');
    await expect(field(section, 'empty')).toBeVisible();
  });

  test('ACC-PANEL-131 every run is listed: a run with --device shows that device, and a run without it whose process holds no port shows no device', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    // `cat` runs until its standard input ends, and it opens no device.
    const plain = startRun(['--', 'cat']);
    const named = startRun(['--device', port.name, '--', 'cat', '-u']);

    const plainRow = await listed(page, plain);
    const namedRow = await listed(page, named);
    await expect(field(runsSection(page), 'count')).toHaveText('(2)');
    await expect(field(plainRow, 'program')).toHaveText('cat');
    await expect(field(plainRow, 'command')).toHaveText('cat');
    await expect(field(plainRow, 'device')).toHaveText('no device');
    await expect(field(namedRow, 'program')).toHaveText('cat');
    await expect(field(namedRow, 'command')).toHaveText('cat -u');
    await expect(field(namedRow, 'device')).toHaveText(port.name);
    expect((await serialRecord(port.name)).holder).toBeNull();
  });

  test('ACC-PANEL-147 Start opens a terminal tab whose first text is the banner of a device shell, with no command line typed; the panel lists the shell as the run jupyterlab-device shell; a tool started in the shell passes its DTR and RTS calls to the port; exit closes the tab, and the run leaves the panel', async ({
    page
  }) => {
    const port = simSerial();
    const device = simUsb();
    await openLab(page, { serial: [port], usb: [device] });
    await addSerial(page, port);
    await addUsb(page, device);
    const { path: devicePath } = await serialRecord(port.name);
    const start = action(runsSection(page), 'start-run');
    await expect(start).toHaveText('Start');

    // The banner lists what is attached: the port with its path, then the USB device.
    const pid = await startShell(page, () => start.click(), [
      `(1) ${devicePath} (COM)`,
      `(2) ${device.name} (USB)`
    ]);

    // The user types the command line of a tool into that terminal.
    const tool = toolCommand(devicePath, [
      ...['--signals', 'dtr=1', 'rts=1'],
      ...['--write', '00', '--read', '1']
    ]);
    await page.locator('.jp-Terminal').click();
    await page.keyboard.type(tool.join(' '));
    await page.keyboard.press('Enter');

    // The tool has the shim: its two calls reach the port, and neither is refused.
    await expect
      .poll(() => simArgs(page, port.id, 'setSignals'), {
        timeout: ROUND_TRIP
      })
      .toEqual([
        [{ dataTerminalReady: true, requestToSend: false }],
        [{ dataTerminalReady: true, requestToSend: true }]
      ]);
    await expect
      .poll(() => terminalText(page), { timeout: ROUND_TRIP })
      .toContain('{"signals": ["ok", "ok"], "read": "00"}');
    // The tool is another process than the shell, so the run of the shell has no device.
    await expect(field(runRow(page, pid), 'device')).toHaveText('no device');

    // The user leaves the shell: the tab of the terminal closes, the shell has ended
    // and its run leaves the panel.
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
      timeout: ROUND_TRIP
    });
    await expect(runRow(page, pid)).toHaveCount(0, { timeout: ROUND_TRIP });
    await expect.poll(() => fs.existsSync(`/proc/${pid}`)).toBe(false);
  });

  test('DEF-PANEL-15 with no variable SHELL in the environment of the server and of its terminals, Start gives a running shell with the banner', async ({
    page
  }) => {
    // The shell command of the lab's terminals is the one that the config of the test
    // server pins, whatever the machine sets for its own lab.
    expect((await api('GET', 'status')).body.shell).toEqual(['/bin/bash']);
    await openLab(page, {});

    const pid = await startShell(page, () =>
      action(runsSection(page), 'start-run').click()
    );

    // The process of the run is that shell command, started with the preload shim and
    // without the variable: the server has none, so its terminals have none.
    const words = (file: string): string[] =>
      fs
        .readFileSync(`/proc/${pid}/${file}`, 'utf8')
        .split('\0')
        .filter(Boolean);
    expect(words('cmdline')).toEqual(['/bin/bash']);
    const variables = words('environ').map(entry => entry.split('=')[0]);
    expect(variables).toContain('LD_PRELOAD');
    expect(variables).not.toContain('SHELL');
    // The shell runs: it answers a command.
    await page.locator('.jp-Terminal').click();
    await page.keyboard.type('echo answer-$((6*7))');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => terminalText(page), { timeout: ROUND_TRIP })
      .toMatch(/^answer-42$/m);
  });

  test('ACC-CLI-162 when the folder of the file browser exists no more, Start raises the notification that the terminal did not start with the code of the terminal extension, and no run begins', async ({
    page,
    tmpPath
  }) => {
    await openLab(page, {});
    // The file browser stands in a folder that is then removed on the disk. The lab
    // learns that at the next refresh of the file browser, so Start comes before it.
    const folder = `${tmpPath}/removed-folder`;
    await page.contents.createDirectory(folder);
    await page.evaluate(
      path =>
        (window as any).jupyterapp.commands.execute('filebrowser:go-to-path', {
          path,
          dontShowBrowser: true
        }),
      folder
    );
    // The Contents API of the test server moves a folder to the trash and has none
    // here, so the folder is removed on the disk.
    fs.rmSync(join((await page.getServerRoot())!, folder), { recursive: true });

    await action(runsSection(page), 'start-run').click();

    await expect(
      toast(page, 'The terminal did not start: invalid_cwd')
    ).toBeVisible({ timeout: ROUND_TRIP });
    await expect(runsSection(page).locator('[data-run]')).toHaveCount(0);
    expect(await runPids()).toEqual([]);
  });

  test('ACC-PANEL-147 the command Device Shell of the command palette opens a terminal tab with the banner of a device shell and no command line typed, and the panel lists the shell as the run jupyterlab-device shell', async ({
    page
  }) => {
    await openLab(page, {});

    await startShell(page, () => runFromPalette(page, COMMANDS.startRun));
  });

  test('ACC-PANEL-133 the second click on Stop ends the program of a run and its row leaves the panel, and the first click ends nothing', async ({
    page
  }) => {
    await openLab(page, {});
    const run = startRun(['--', 'cat']);
    const rowOfRun = await listed(page, run);
    const stop = action(rowOfRun, 'stop-run');
    await expect(stop).toHaveText('Stop');

    await stop.click();
    await expect(stop).toHaveText('Confirm stop');
    // The second click counts 500 ms after the first. Until then nothing is stopped.
    await page.waitForTimeout(600);
    expect(await runPids()).toContain(run.pid);
    expect(run.process.exitCode).toBeNull();
    expect(run.process.signalCode).toBeNull();
    await stop.click();

    // The server sent SIGHUP, which ends `cat`.
    await expect
      .poll(() => run.process.signalCode, { timeout: ROUND_TRIP })
      .toBe('SIGHUP');
    await expect(rowOfRun).toHaveCount(0, { timeout: ROUND_TRIP });
    await expect(field(runsSection(page), 'count')).toHaveText('(0)');
  });

  test('ACC-PANEL-133 Stop ends the device shell that Start started in a terminal of the lab, and its row leaves the panel', async ({
    page
  }) => {
    await openLab(page, {});
    const pid = await startShell(page, () =>
      action(runsSection(page), 'start-run').click()
    );
    expect(fs.existsSync(`/proc/${pid}`)).toBe(true);
    const stop = action(runRow(page, pid), 'stop-run');

    await stop.click();
    await expect(stop).toHaveText('Confirm stop');
    await page.waitForTimeout(600);
    await stop.click();

    // SIGHUP ends an interactive shell; SIGTERM, which it ignores, would leave it 3 s.
    await expect(runRow(page, pid)).toHaveCount(0, { timeout: ROUND_TRIP });
    await expect.poll(() => fs.existsSync(`/proc/${pid}`)).toBe(false);
    await expect(field(runsSection(page), 'count')).toHaveText('(0)');
  });

  test('ACC-PANEL-134 the Info button is hidden while no run exists; with a run its dialog lists the attached devices, the serial port with its path, and shows the three example lines with that path', async ({
    page
  }) => {
    const port = simSerial();
    const device = simUsb();
    await openLab(page, { serial: [port], usb: [device] });
    await addSerial(page, port);
    await addUsb(page, device);
    const section = runsSection(page);
    const info = action(section, 'run-info');
    // The button is in the section, as Start is, and it is not shown.
    await expect(action(section, 'start-run')).toBeVisible();
    await expect(info).toHaveCount(1);
    await expect(info).toBeHidden();

    const run = startRun(['--', 'cat']);
    await whileRunning(run, expect(info).toBeVisible({ timeout: ROUND_TRIP }));
    await expect(info).toHaveText('Info');
    await info.click();

    const dialog = page.locator('.jp-Dialog');
    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'How to connect a tool'
    );
    const body = dialog.locator('.jp-DeviceBridgeInfo');
    const { path: devicePath } = await serialRecord(port.name);
    expect(devicePath).toBe(`${DEVICE_DIR}/${port.name}`);
    await expect(body.locator('[data-info-device]')).toHaveCount(2);
    const serialLine = body.locator(`[data-info-device="${port.name}"]`);
    await expect(field(serialLine, 'name')).toHaveText(port.name);
    await expect(field(serialLine, 'path')).toHaveText(devicePath);
    // A USB device has no path: a program reaches it through the bridge.
    const usbLine = body.locator(`[data-info-device="${device.name}"]`);
    await expect(field(usbLine, 'name')).toHaveText(device.name);
    await expect(field(usbLine, 'path')).toHaveCount(0);
    const example = (tool: string): Locator =>
      body.locator(`[data-example="${tool}"]`);
    await expect(example('avrdude')).toHaveText(
      `avrdude -c arduino -p atmega328p -b 115200 -P ${devicePath} -U flash:w:firmware.hex:i`
    );
    await expect(example('stm32flash')).toHaveText(
      `stm32flash -b 115200 -w firmware.bin -v -g 0x0 ${devicePath}`
    );
    await expect(example('esptool')).toHaveText(
      `esptool --port ${devicePath} write-flash 0x0 firmware.bin`
    );
    await expect(field(body, 'note')).toHaveText(
      'Type a line in a device shell. The button Start of the section Device shell and tools opens one. No line was run against a board.'
    );

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // The run ends: no run exists, and the button is hidden again.
    run.process.stdin!.end();
    expect((await run.done).code).toBe(0);
    await expect(info).toBeHidden({ timeout: ROUND_TRIP });
  });

  test.describe('from the Devices menu', () => {
    // The menu bar moves the entries that do not fit into one overflow entry.
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('ACC-PANEL-140 the Devices menu has the entry Device Shell, which opens a lab terminal whose banner names a device shell, and no text of the menu, of the panel and of the banner holds the word shim', async ({
      page
    }) => {
      await openLab(page, {});
      await setShowMenu(page, true);
      await menuBarEntry(page, 'Devices').click();
      const labels = page.locator(`${MENU} .lm-Menu-itemLabel`);
      await expect(labels).toHaveCount(5);
      await expect(labels.nth(3)).toHaveText('Device Shell');
      expect((await labels.allTextContents()).join('\n')).not.toMatch(/shim/i);
      const section = runsSection(page);
      await expect(section).toContainText('Device shell and tools');
      await expect(action(section, 'start-run')).toHaveAttribute(
        'title',
        'Open a device shell'
      );

      // The helper reads the banner: its name line ends with `device shell`, and no
      // line of it holds the word shim.
      await startShell(page, () =>
        page
          .locator(`${MENU} .lm-Menu-item`)
          .filter({ hasText: 'Device Shell' })
          .click()
      );

      // The panel lists the shell now. None of its texts and tooltips holds the word.
      const panel = page.locator(PANEL);
      const tooltips = await panel
        .locator('[title]')
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
      expect(tooltips.length).toBeGreaterThan(0);
      expect(`${await panel.innerText()}\n${tooltips.join('\n')}`).not.toMatch(
        /shim/i
      );
    });
  });
});

test.describe('Devices menu', () => {
  // The menu bar moves the entries that do not fit into one overflow entry.
  test.use({
    mockSettings: PANEL_SHOWN,
    viewport: { width: 1920, height: 1080 }
  });

  test('ACC-PANEL-68 with the default settings the lab has no Devices menu', async ({
    page
  }) => {
    await openLab(page, {});
    // The settings of the plugin are loaded, and showMenu is false in them.
    expect(await getSetting(page, 'showMenu')).toBe(false);

    // A positive control of the locator, then no Devices entry.
    await expect(menuBarEntry(page, 'File')).toHaveCount(1);
    await expect(menuBarEntry(page, 'Devices')).toHaveCount(0);
  });

  test('ACC-PANEL-69 with showMenu true the lab shows a Devices menu with its entries, without a reload', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await expect(menuBarEntry(page, 'Devices')).toHaveCount(0);

    await setShowMenu(page, true);

    await expect(menuBarEntry(page, 'Devices')).toHaveCount(1);
    await menuBarEntry(page, 'Devices').click();
    await expect(page.locator(`${MENU} .lm-Menu-itemLabel`)).toHaveText([
      'Connect Serial Port',
      'Connect USB Device',
      'Serial Terminal',
      'Device Shell',
      'Show Devices Panel'
    ]);
    await page
      .locator(`${MENU} .lm-Menu-item`)
      .filter({ hasText: 'Connect Serial Port' })
      .click();
    await expect
      .poll(() => simDialogs(page))
      .toEqual([
        { kind: 'serial', options: null, outcome: 'granted', device: port.id }
      ]);
    await expect
      .poll(async () => (await serialRecord(port.name))?.portState, {
        timeout: ROUND_TRIP
      })
      .toBe('open');

    // The setting works both ways without a reload.
    await setShowMenu(page, false);
    await expect(menuBarEntry(page, 'Devices')).toHaveCount(0);
  });
});

test.describe('Show Devices Panel', () => {
  // These tests run with the default settings: the Devices panel is hidden at the
  // start. The View menu is long, and the menu bar moves the entries that do not fit
  // into one overflow entry.
  test.use({ viewport: { width: 1920, height: 1080 } });

  const FILE_BROWSER_TAB = '.jp-SideBar .lm-TabBar-tab[data-id="filebrowser"]';

  /** Load the lab with the default settings, show the Devices panel with the View menu item and add the port. */
  async function labWithPort(
    page: IJupyterLabPageFixture,
    port: ISimSerial
  ): Promise<void> {
    await simulate(page, { serial: [port] });
    await page.goto();
    await chooseViewItem(page);
    await expect(page.locator(PANEL)).toBeVisible();
    await addSerial(page, port);
  }

  test('ACC-PANEL-113 with the default settings the left sidebar has no Devices panel and the setting showPanel is false', async ({
    page
  }) => {
    await simulate(page, {});
    await page.goto();

    // The plugin is active and its settings are loaded.
    expect(
      await page.evaluate(
        command => (window as any).jupyterapp.commands.hasCommand(command),
        COMMANDS.showPanel[0]
      )
    ).toBe(true);
    expect(await getSetting(page, 'showPanel')).toBe(false);

    // A positive control of the locator of a sidebar tab, then no Devices tab and no panel.
    await expect(page.locator(FILE_BROWSER_TAB)).toHaveCount(1);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await viewItemMarked(page)).toBe(false);
  });

  test.describe('with a saved layout that names the Devices panel', () => {
    // The workspace of the lab holds the layout of a session in which the Devices
    // panel was the open panel of the left sidebar. The lab restores that layout
    // when the page loads.
    test.use({
      mockState: {
        'layout-restorer:data': {
          left: {
            collapsed: false,
            visible: true,
            current: PANEL.slice(1),
            widgets: ['filebrowser', PANEL.slice(1)]
          }
        }
      }
    });

    test('ACC-PANEL-113 a saved layout that names the Devices panel does not put the panel into the sidebar while showPanel is false', async ({
      page
    }) => {
      await simulate(page, {});
      await page.goto();

      expect(await getSetting(page, 'showPanel')).toBe(false);
      await expect(page.locator(FILE_BROWSER_TAB)).toHaveCount(1);
      await expect(page.locator(PANEL_TAB)).toHaveCount(0);
      await expect(page.locator(PANEL)).toHaveCount(0);
      expect(await viewItemMarked(page)).toBe(false);
    });

    test.describe('and showPanel true', () => {
      test.use({ mockSettings: PANEL_SHOWN });

      test('ACC-PANEL-115 with showPanel true the lab restores the Devices panel from the saved layout as the open panel of the left sidebar', async ({
        page
      }) => {
        await simulate(page, {});
        await page.goto();

        // Nothing was clicked: the panel was in the sidebar before the lab restored its layout.
        await expect(page.locator(PANEL)).toBeVisible();
        await expect(page.locator(PANEL_TAB)).toHaveClass(/lm-mod-current/);
        await expect(page.locator(`#jp-left-stack ${PANEL}`)).toHaveCount(1);
        expect(await viewItemMarked(page)).toBe(true);
      });
    });
  });

  test('ACC-PANEL-114 the View menu item Show Devices Panel puts the panel into the left sidebar, opens it and gets a check mark; chosen again it removes the panel and the mark', async ({
    page
  }) => {
    await simulate(page, {});
    await page.goto();
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);

    const item = await openViewMenu(page);
    await expect(item.locator('.lm-Menu-itemLabel')).toHaveText(
      'Show Devices Panel'
    );
    await expect(item).not.toHaveClass(TOGGLED);
    // The item is in the group of Show Notifications and Show Log Console.
    const group = await page.evaluate(
      ([menu, command]) => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(`${menu} > ul > li`)
        );
        const separator = (index: number): boolean =>
          items[index].dataset.type === 'separator';
        const at = items.findIndex(each => each.dataset.command === command);
        let first = at;
        while (first > 0 && !separator(first - 1)) {
          first--;
        }
        let last = at;
        while (last < items.length - 1 && !separator(last + 1)) {
          last++;
        }
        return items.slice(first, last + 1).map(each => each.dataset.command);
      },
      [VIEW_MENU, COMMANDS.showPanel[0]]
    );
    expect(group).toEqual(
      expect.arrayContaining([
        'apputils:display-notifications',
        'logconsole:open',
        COMMANDS.showPanel[0]
      ])
    );

    await item.click();

    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(PANEL_TAB)).toHaveCount(1);
    await expect(page.locator(PANEL_TAB)).toHaveClass(/lm-mod-current/);
    // The panel is in the left sidebar, not in the right one.
    await expect(page.locator(`#jp-left-stack ${PANEL}`)).toHaveCount(1);
    expect(await viewItemMarked(page)).toBe(true);

    await chooseViewItem(page);

    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);
    // A positive control: the sidebar itself is still there.
    await expect(page.locator(FILE_BROWSER_TAB)).toHaveCount(1);
    expect(await viewItemMarked(page)).toBe(false);
  });

  test('ACC-PANEL-115 the View menu item writes the setting showPanel, a change of the setting shows and hides the panel and its check mark without a reload, and the value holds after a reload', async ({
    page
  }) => {
    await simulate(page, {});
    await page.goto();
    expect(await getSetting(page, 'showPanel')).toBe(false);

    // The menu item writes the setting.
    await chooseViewItem(page);
    await expect(page.locator(PANEL)).toBeVisible();
    await stored(page, true);

    // The setting hides the panel and removes the mark.
    await setSetting(page, 'showPanel', false);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await viewItemMarked(page)).toBe(false);

    // The setting shows the panel and sets the mark.
    await setSetting(page, 'showPanel', true);
    await expect(page.locator(PANEL_TAB)).toHaveCount(1);
    expect(await viewItemMarked(page)).toBe(true);

    // The lab reads the stored value when the page loads again.
    await page.reload();
    await expect(page.locator(PANEL_TAB)).toHaveCount(1);
    expect(await getSetting(page, 'showPanel')).toBe(true);
    expect(await viewItemMarked(page)).toBe(true);

    // The menu item writes false as well, and that value holds after a reload too.
    await chooseViewItem(page);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await stored(page, false);
    await page.reload();
    await expect(page.locator(FILE_BROWSER_TAB)).toHaveCount(1);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    expect(await getSetting(page, 'showPanel')).toBe(false);
  });

  test('ACC-PANEL-116 hiding the panel with the View menu item detaches no device: the port stays attached and open, bytes a tool writes reach it, and the status bar item counts it', async ({
    page
  }) => {
    const port = simSerial();
    await labWithPort(page, port);
    const before = await serialRecord(port.name);
    const status = page.locator(STATUS_ITEM);
    await expect(field(status, 'count')).toHaveText('1');

    await chooseViewItem(page);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);

    // A tool writes through the virtual device; the simulated port sends the bytes back.
    const tool = startTool(before.path, ['--write', '55aa', '--read', '2']);
    expect(toolReport(await tool.done).read).toEqual([0x55, 0xaa]);
    await expect.poll(() => simWritten(page, port.id)).toEqual([0x55, 0xaa]);

    expect(await serialRecord(port.name)).toMatchObject({
      state: 'attached',
      portState: 'open',
      tab: before.tab,
      path: before.path
    });
    // The tab opened the port once and never closed it.
    expect(await simArgs(page, port.id, 'open')).toHaveLength(1);
    expect(await simArgs(page, port.id, 'close')).toEqual([]);
    await expect(status).toBeVisible();
    await expect(field(status, 'count')).toHaveText('1');

    // Shown again, the panel lists the port as attached, with the bytes counted.
    await chooseViewItem(page);
    const portRow = row(page, port.name);
    await expect(portRow).toHaveAttribute('data-owner', 'this');
    await expect(field(portRow, 'state')).toHaveText('attached');
    await expect(field(portRow, 'tx')).toHaveText('2', { timeout: ROUND_TRIP });
  });

  test('ACC-PANEL-122 when the lab cannot save showPanel the View menu item still shows the panel and marks the item, and a toast says that the setting was not saved', async ({
    page
  }) => {
    await simulate(page, {});
    await page.goto();
    // From here on the server refuses every save of a setting.
    await page.route(/\/api\/settings\//, route =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500 })
        : route.fallback()
    );

    await chooseViewItem(page);

    await expect(page.locator(PANEL)).toBeVisible();
    expect(await viewItemMarked(page)).toBe(true);
    const warning = toast(
      page,
      'The Devices panel is shown now, but the lab could not save the setting showPanel: '
    );
    await expect(warning).toBeVisible();
    // The reason of the lab ends the text, and the lab did not cut it.
    await expect(warning).not.toContainText('…');
    expect(await getSetting(page, 'showPanel')).toBe(false);
  });

  test('ACC-PANEL-117 a click on the status bar item while the panel is hidden sets showPanel true and opens the panel', async ({
    page
  }) => {
    const port = simSerial();
    await labWithPort(page, port);
    await chooseViewItem(page);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await stored(page, false);
    const status = page.locator(STATUS_ITEM);
    await expect(status).toBeVisible();

    await status.click();

    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(PANEL_TAB)).toHaveClass(/lm-mod-current/);
    await stored(page, true);
    expect(await viewItemMarked(page)).toBe(true);
    await expect(row(page, port.name)).toHaveAttribute('data-owner', 'this');

    // While the panel is shown, a click opens it and leaves the setting as it is.
    await page.locator(FILE_BROWSER_TAB).click();
    await expect(page.locator(PANEL)).toBeHidden();
    await status.click();
    await expect(page.locator(PANEL)).toBeVisible();
    expect(await getSetting(page, 'showPanel')).toBe(true);
  });

  test('ACC-PANEL-67 show devices panel, connect serial port, connect USB device and open serial terminal run from the command palette', async ({
    page
  }) => {
    const port = simSerial();
    const device = simUsb();
    await simulate(page, { serial: [port], usb: [device] });
    await page.goto();

    // Show Devices Panel: with the default settings the panel is not in the sidebar.
    await expect(page.locator(FILE_BROWSER_TAB)).toHaveCount(1);
    await expect(page.locator(PANEL_TAB)).toHaveCount(0);
    await runFromPalette(page, COMMANDS.showPanel);
    await expect(page.locator(PANEL)).toBeVisible();

    await runFromPalette(page, COMMANDS.connectSerial);
    await expect
      .poll(async () => (await serialRecord(port.name))?.portState, {
        timeout: ROUND_TRIP
      })
      .toBe('open');

    await runFromPalette(page, COMMANDS.connectUsb);
    await expect
      .poll(async () => (await usbRecord(device.name))?.state, {
        timeout: ROUND_TRIP
      })
      .toBe('attached');
    expect(
      (await simDialogs(page)).map(dialog => [dialog.kind, dialog.outcome])
    ).toEqual([
      ['serial', 'granted'],
      ['usb', 'granted']
    ]);

    // Serial Terminal: a terminal of the lab runs the terminal program on the port.
    await runFromPalette(page, COMMANDS.openTerminal);
    const { path: devicePath } = await serialRecord(port.name);
    await expect
      .poll(() => terminalText(page), { timeout: TERMINAL_START })
      .toContain(`--- Miniterm on ${devicePath}`);
  });
});
