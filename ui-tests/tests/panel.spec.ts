import { expect, IJupyterLabPageFixture, test } from '@jupyterlab/galata';
import type { Locator, Page } from '@playwright/test';

import {
  action,
  addSerial,
  addUsb,
  api,
  field,
  forget,
  getSetting,
  ISimCall,
  ISimSerial,
  openLab,
  openSecondTab,
  PANEL,
  PANEL_SHOWN,
  PANEL_TAB,
  ROUND_TRIP,
  row,
  runCli,
  serialRecord,
  setSetting,
  simArgs,
  simDialogs,
  simSend,
  simSerial,
  simulate,
  simUsb,
  simWritten,
  startTool,
  STATUS_ITEM,
  terminalText,
  toast,
  toolReport,
  usbRecord
} from './helpers';

/**
 * Functional tests of the Devices panel, the status bar item, the commands, the
 * Devices menu and the option that shows the panel: the real lab, worker and server,
 * with simulated devices in the browser (device-sim.js). Ids in the titles are the
 * criteria of docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false });

const MENU = '#jp-mainmenu-devices';
const VIEW_MENU = '#jp-mainmenu-view';
const COMMANDS = {
  connectSerial: ['device-bridge:connect-serial', 'Connect Serial Port'],
  connectUsb: ['device-bridge:connect-usb', 'Connect USB Device'],
  openTerminal: ['device-bridge:open-terminal', 'Serial Terminal'],
  showPanel: ['device-bridge:show-panel', 'Show Devices Panel']
};
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

  test('ACC-PANEL-70 when the browser has neither interface the panel names HTTPS and localhost and disables both add buttons', async ({
    page
  }) => {
    await openLab(page, { absent: true });
    const panel = page.locator(PANEL);

    const absent = field(panel, 'absent');
    await expect(absent).toBeVisible();
    await expect(absent).toContainText('HTTPS');
    await expect(absent).toContainText('localhost');
    await expect(action(panel, 'connect-serial')).toBeDisabled();
    await expect(action(panel, 'connect-usb')).toBeDisabled();
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

    await action(page.locator(PANEL), 'connect-serial').click();

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

    // Serial Terminal: a lab terminal opens and gets the command line for the port.
    await runFromPalette(page, COMMANDS.openTerminal);
    await expect
      .poll(() => terminalText(page), { timeout: ROUND_TRIP })
      .toContain(`jupyterlab-device terminal ${port.name}`);
  });
});
