import { expect, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

import {
  action,
  addSerial,
  closeTerminals,
  expectAppHeader,
  ISimSerial,
  openLab,
  PANEL_SHOWN,
  ROUND_TRIP,
  row,
  serialRecord,
  simSend,
  simSerial,
  simWritten,
  startTool,
  terminalText,
  toast
} from './helpers';

/**
 * Functional tests of the serial terminal: the lab starts the real
 * `jupyterlab-device terminal` in a terminal of the lab through the basic terminal
 * extension, the command runs the extension's Textual app on the virtual serial device,
 * and a simulated port in the browser (device-sim.js) is the other end. Ids in the titles
 * are the criteria of docs/acc-crit-device-bridge.md and the defects of
 * docs/defects-device-bridge.md.
 */

// The server makes the terminal, and the lab opens it by its name. Galata answers the
// list of the terminals itself, from the terminals a page made, and the lab would not
// find that terminal in it. So the terminals API is the real one here, and each test
// ends the terminals of the server itself.
test.use({ autoGoto: false, mockSettings: PANEL_SHOWN, terminals: null });
test.afterEach(closeTerminals);

/** The terminal starts the CLI, which asks the server and starts the app. */
const TERMINAL_START = 45000;
const OPEN_TERMINAL = 'device-bridge:open-terminal';

const bytes = (text: string): number[] => [...Buffer.from(text)];

/** Run a command of the lab. */
const execute = (page: Page, command: string): Promise<void> =>
  page.evaluate(async id => {
    await (window as any).jupyterapp.commands.execute(id);
  }, command);

/** Wait until the app holds the virtual device of the port in a terminal tab of the lab. */
async function terminalApp(page: Page, port: ISimSerial): Promise<void> {
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);
  await expect
    .poll(async () => (await serialRecord(port.name)).holder?.name, {
      timeout: TERMINAL_START
    })
    .toBe('jupyterlab-devi');
}

/**
 * Wait until the tab of the serial terminal app is visible in the dock tab bar, titled
 * Serial Terminal, with the icon of the device bridge in it.
 */
async function expectSerialTerminalTab(page: Page): Promise<void> {
  const tab = page
    .locator('.lm-DockPanel-tabBar .lm-TabBar-tab')
    .filter({ hasText: 'Serial Terminal' });
  await expect(tab).toHaveCount(1);
  await expect(tab).toBeVisible();
  await expect(tab.locator('.lm-TabBar-tabIcon svg')).toHaveCount(1);
}

test.describe('serial terminal', () => {
  test('ACC-TERM-74 the serial terminal command opens a lab terminal with the terminal program on the virtual device, and the output of the port appears in it', async ({
    page
  }) => {
    const port = simSerial();
    const line = `sensor of ${port.name}: 21.5 C`;
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    await execute(page, OPEN_TERMINAL);
    await terminalApp(page, port);
    await expectSerialTerminalTab(page);
    expect(await terminalText(page)).not.toContain(line);
    await simSend(page, port.id, bytes(`${line}\r\n`));

    await expect
      .poll(() => terminalText(page), { timeout: TERMINAL_START })
      .toContain(line);
  });

  test('ACC-TERM-75 a line the user types in the serial terminal is written to the port on Enter', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    await execute(page, OPEN_TERMINAL);
    await terminalApp(page, port);
    expect(await simWritten(page, port.id)).toEqual([]);

    // The send field of the app has the focus; Enter sends the line with a line feed.
    await page.locator('.jp-Terminal').click();
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');

    await expect
      .poll(() => simWritten(page, port.id), { timeout: TERMINAL_START })
      .toEqual(bytes('abc\n'));
  });

  test('ACC-TERM-148 the Terminal button of a serial row starts the terminal program in a terminal tab with no command line typed, the tab shows the output of the port, and Ctrl+Q closes the tab', async ({
    page
  }) => {
    const port = simSerial();
    const line = `boot of ${port.name}`;
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    await expect(page.locator('.jp-Terminal')).toHaveCount(0);

    await action(row(page, port.name), 'terminal').click();

    await terminalApp(page, port);
    await expectSerialTerminalTab(page);
    await expect(page.locator('.jp-Terminal')).toHaveCount(1);
    // The lab typed no command line: the first row is the header of the app, and no
    // line holds the command line.
    const text = await terminalText(page);
    expect(text.split('\n')[0]).toMatch(/^ ?jupyterlab-device terminal · /);
    expect(text).not.toContain(`jupyterlab-device terminal ${port.name}`);
    await simSend(page, port.id, bytes(`${line}\r\n`));
    await expect
      .poll(() => terminalText(page), { timeout: TERMINAL_START })
      .toContain(line);

    // Ctrl+Q is the key of the app that ends it. The tab closes with the program,
    // and no program holds the port.
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

  test('ACC-PANEL-149 the serial terminal command on a port that another program holds keeps its terminal tab open with the message of the CLI and the line Press Enter to close this terminal., and Enter closes the tab', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path } = await serialRecord(port.name);
    // A tool that opens the virtual device and holds it until a line arrives on stdin.
    const tool = startTool(path, ['--hold']);
    try {
      await tool.firstLine;
      await expect
        .poll(async () => (await serialRecord(port.name)).holder?.pid, {
          timeout: ROUND_TRIP
        })
        .toBe(tool.process.pid);
      const { holder } = await serialRecord(port.name);

      await execute(page, OPEN_TERMINAL);

      // The CLI refuses at once with status 1. Its message stays readable: the
      // terminal shows it and waits for one line of input.
      await expect
        .poll(() => terminalText(page), { timeout: TERMINAL_START })
        .toContain('Press Enter to close this terminal.');
      const lines = (await terminalText(page)).trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(
        `${port.name} is held by ${holder.name} (pid ${holder.pid})`
      );
      expect(lines[1]).toBe('Press Enter to close this terminal.');
      await expect(page.locator('.jp-Terminal')).toHaveCount(1);
      // The app did not start: the tool still holds the port.
      expect((await serialRecord(port.name)).holder.pid).toBe(tool.process.pid);

      await page.locator('.jp-Terminal').click();
      await page.keyboard.press('Enter');
      await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
        timeout: ROUND_TRIP
      });
    } finally {
      // The tool is a child of this test. It is ended also when the test failed.
      tool.process.kill('SIGKILL');
      await tool.done;
    }
  });

  test('DEF-PANEL-11 the serial terminal command without an attached port, and with the name of no attached port, displays its warning as a toast and opens no terminal', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    const run = (args: Record<string, string> = {}): Promise<void> =>
      page.evaluate(
        async ([id, given]) => {
          await (window as any).jupyterapp.commands.execute(id, given);
        },
        [OPEN_TERMINAL, args] as [string, Record<string, string>]
      );

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
