import { expect, test } from '@jupyterlab/galata';

import {
  action,
  addSerial,
  closeTerminals,
  expectAppHeader,
  openLab,
  PANEL_SHOWN,
  ROUND_TRIP,
  row,
  serialRecord,
  simArgs,
  simSend,
  simSerial,
  terminalText
} from './helpers';

/**
 * Functional test of the serial terminal app: the Terminal button of a serial row
 * starts the real `jupyterlab-device terminal` in a lab terminal, and that command runs
 * the extension's own Textual app on the virtual serial device of a simulated port
 * (device-sim.js). The id in the title is a criterion of docs/acc-crit-device-bridge.md.
 */

// The server makes the terminal and the lab opens it by its name, so the terminals API
// is the real one, and each test ends the terminals of the server itself.
test.use({ autoGoto: false, mockSettings: PANEL_SHOWN, terminals: null });
test.afterEach(closeTerminals);

/** The terminal starts the CLI, which asks the server and starts the app. */
const TERMINAL_START = 45000;

test('ACC-TERM-165 the Terminal button of a serial row opens a lab terminal that shows the header of the Textual app, the app holds the port and shows its output, and Ctrl+Q closes the tab', async ({
  page
}) => {
  const port = simSerial();
  const line = `boot of ${port.name}`;
  await openLab(page, { serial: [port] });
  await addSerial(page, port);
  await expect(page.locator('.jp-Terminal')).toHaveCount(0);

  await action(row(page, port.name), 'terminal').click();

  // The first row of the screen is the header of the app: its name, then the device.
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);
  await expect
    .poll(async () => (await serialRecord(port.name)).holder?.name, {
      timeout: TERMINAL_START
    })
    .toBe('jupyterlab-devi');
  await simSend(page, port.id, [...Buffer.from(`${line}\r\n`)]);
  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toMatch(new RegExp(`\\d\\d:\\d\\d:\\d\\d\\.\\d{3} RX ${line}`));

  await page.locator('.jp-Terminal').click();
  await page.keyboard.press('Control+q');
  await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
    timeout: ROUND_TRIP
  });
  await expect
    .poll(async () => (await serialRecord(port.name)).holder, {
      timeout: ROUND_TRIP
    })
    .toBeNull();
});

test('ACC-TERM-169 in a lab terminal F2 sets DTR off and F6 pulses DTR on the simulated port: the function keys of the board actions reach the app through the lab and xterm.js', async ({
  page
}) => {
  const port = simSerial();
  await openLab(page, { serial: [port] });
  await addSerial(page, port);
  await action(row(page, port.name), 'terminal').click();
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);
  /** The DTR state of each control line call on the simulated port, in order. */
  const dtr = async (): Promise<boolean[]> =>
    (await simArgs(page, port.id, 'setSignals')).map(
      ([signals]) => signals.dataTerminalReady
    );
  const before = (await dtr()).length;

  await page.locator('.jp-Terminal').click();
  await page.keyboard.press('F2');
  await expect
    .poll(async () => (await dtr()).slice(before), { timeout: ROUND_TRIP })
    .toEqual([false]);
  await page.keyboard.press('F6');
  await expect
    .poll(async () => (await dtr()).slice(before), { timeout: ROUND_TRIP })
    .toEqual([false, false, true]);

  await page.keyboard.press('Control+q');
  await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
    timeout: ROUND_TRIP
  });
});

test('ACC-TERM-198 in a lab terminal Ctrl+Y opens the key help of the serial terminal app, which lists the keys with what they do, and Esc closes it', async ({
  page
}) => {
  const port = simSerial();
  await openLab(page, { serial: [port] });
  await addSerial(page, port);
  await action(row(page, port.name), 'terminal').click();
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);
  expect(await terminalText(page)).toMatch(/\^y keys/);

  await page.locator('.jp-Terminal').click();
  await page.keyboard.press('Control+y');
  await expect
    .poll(() => terminalText(page), { timeout: ROUND_TRIP })
    .toContain('Keys of the serial terminal');
  const help = await terminalText(page);
  expect(help).toMatch(/F2 +set DTR off, or on when it is off/);
  expect(help).toMatch(/\^c +send the byte 0x03 to the board/);
  expect(help).toContain('Esc or ^y closes this list');

  await page.keyboard.press('Escape');
  await expect
    .poll(() => terminalText(page), { timeout: ROUND_TRIP })
    .not.toContain('Keys of the serial terminal');
  await page.keyboard.press('Control+q');
  await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
    timeout: ROUND_TRIP
  });
});
