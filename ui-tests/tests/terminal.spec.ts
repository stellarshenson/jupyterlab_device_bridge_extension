import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import {
  addSerial,
  ISimSerial,
  openLab,
  PANEL_SHOWN,
  serialRecord,
  simSend,
  simSerial,
  simWritten,
  terminalText,
  toast
} from './helpers';

/**
 * Functional tests of the serial terminal: the lab command opens a real lab terminal,
 * the real `jupyterlab-device terminal` in it becomes pyserial's miniterm on the
 * virtual serial device, and a simulated port in the browser (device-sim.js) is the
 * other end. Ids in the titles are the criteria of docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

/** The command starts a shell, the CLI and miniterm, each a process of its own. */
const TERMINAL_START = 45000;

const bytes = (text: string): number[] => [...Buffer.from(text)];

/** Run the lab command and wait until miniterm holds the virtual device of the port. */
async function openSerialTerminal(page: Page, port: ISimSerial): Promise<void> {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute(
      'device-bridge:open-terminal'
    );
  });
  // The command line that the lab typed, then the banner of miniterm with the path.
  const { path } = await serialRecord(port.name);
  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toContain(`--- Miniterm on ${path}`);
  expect(await terminalText(page)).toContain(
    `jupyterlab-device terminal ${port.name}`
  );
  await expect
    .poll(async () => (await serialRecord(port.name)).holder?.name, {
      timeout: TERMINAL_START
    })
    .toMatch(/^python/);
}

test.describe('serial terminal', () => {
  test('ACC-TERM-74 the serial terminal command opens a lab terminal with the terminal program on the virtual device, and the output of the port appears in it', async ({
    page
  }) => {
    const port = simSerial();
    const line = `sensor of ${port.name}: 21.5 C`;
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    await openSerialTerminal(page, port);
    expect(await terminalText(page)).not.toContain(line);
    await simSend(page, port.id, bytes(`${line}\r\n`));

    await expect
      .poll(() => terminalText(page), { timeout: TERMINAL_START })
      .toContain(line);
  });

  test('ACC-TERM-75 what the user types in the serial terminal is written to the port', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    await openSerialTerminal(page, port);
    expect(await simWritten(page, port.id)).toEqual([]);

    await page.locator('.jp-Terminal').click();
    await page.keyboard.type('abc');

    await expect
      .poll(() => simWritten(page, port.id), { timeout: TERMINAL_START })
      .toEqual(bytes('abc'));
  });

  test('DEF-PANEL-11 the serial terminal command without an attached port, and with the name of no attached port, displays its warning as a toast and opens no terminal', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    const run = (args: Record<string, string> = {}): Promise<void> =>
      page.evaluate(async given => {
        await (window as any).jupyterapp.commands.execute(
          'device-bridge:open-terminal',
          given
        );
      }, args);

    await run();
    // The whole text: the lab did not cut it.
    await expect(
      toast(
        page,
        'No serial port is attached. Add a serial port in the Devices panel first (if no sidebar has the panel: View → Show Devices Panel).'
      )
    ).toBeVisible();

    await addSerial(page, port);
    await run({ name: 'tty-0000-0000' });
    await expect(
      toast(page, 'No attached serial port has the name tty-0000-0000.')
    ).toBeVisible();
    await expect(page.locator('.jp-Terminal')).toHaveCount(0);
  });
});
