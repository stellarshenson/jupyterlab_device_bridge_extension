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
  simSend,
  simSerial,
  simWritten,
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

/** The row of a line of the terminal buffer that holds this text, with the cell columns. */
interface IRowOfText {
  /** The buffer row of the text, counted from the start of the buffer. */
  row: number;
  /** The first column of the text. */
  start: number;
  /** One column after the last character of the text. */
  end: number;
  /** The first visible row of the buffer. */
  viewportY: number;
  cols: number;
  rows: number;
}

const rowOfText = (page: any, needle: string): Promise<IRowOfText | null> =>
  page.evaluate((wanted: string) => {
    for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
      const term = widget.content?._term;
      const buffer = term?.buffer?.active;
      if (!buffer) {
        continue;
      }
      for (let index = 0; index < buffer.length; index++) {
        const text: string =
          buffer.getLine(index)?.translateToString(true) ?? '';
        const start = text.indexOf(wanted);
        if (start >= 0) {
          return {
            row: index,
            start,
            end: start + wanted.length,
            viewportY: buffer.viewportY,
            cols: term.cols,
            rows: term.rows
          };
        }
      }
    }
    return null;
  }, needle);

/** The text of the xterm selection in the lab terminal, or an empty string. */
const selectionText = (page: any): Promise<string> =>
  page.evaluate(() => {
    for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
      const term = widget.content?._term;
      if (term?.hasSelection?.()) {
        return term.getSelection() as string;
      }
    }
    return '';
  });

/** Read the clipboard; `ok` is false when the browser refuses the read. */
const readClipboard = (page: any): Promise<{ ok: boolean; text: string }> =>
  page.evaluate(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() };
    } catch {
      return { ok: false, text: '' };
    }
  });

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

test('ACC-TERM-242-COPY a mouse selection in the lab terminal copies with Ctrl+C and sends no byte, Ctrl+V pastes and Enter sends it (ACC-TERM-244-PASTE), and Ctrl+C with no selection sends 0x03 (ACC-TERM-243-INTERRUPT)', async ({
  page
}) => {
  const port = simSerial();

  // The lab's terminal copies through the copy event of xterm. A document listener
  // records the text of that event, for a browser that refuses the clipboard read.
  await page.addInitScript(() => {
    (window as any).__copied = [] as string[];
    document.addEventListener('copy', (event: ClipboardEvent) => {
      (window as any).__copied.push(
        event.clipboardData?.getData('text/plain') ?? ''
      );
    });
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await openLab(page, { serial: [port] });
  await addSerial(page, port);

  await action(row(page, port.name), 'terminal').click();
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);

  // The lab terminal takes the mouse: the app must not turn mouse reporting on.
  expect(
    await page.evaluate(() => {
      for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
        if (widget.content?._term) {
          return widget.content._options?.pasteWithCtrlV;
        }
      }
      return null;
    })
  ).toBe(true);

  const known = `copy me ${port.name}`;
  await simSend(page, port.id, [...Buffer.from(`${known}\r\n`)]);
  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toContain(`RX ${known}`);

  // Drag from the first to the last cell of the traffic line, then copy it.
  const found = await rowOfText(page, `RX ${known}`);
  expect(found, 'the traffic line is in the terminal buffer').not.toBeNull();
  const target = found!;
  const screen = await page.locator('.jp-Terminal .xterm-screen').boundingBox();
  expect(screen, 'the terminal screen has a box').not.toBeNull();
  const cellWidth = screen!.width / target.cols;
  const cellHeight = screen!.height / target.rows;
  const y = screen!.y + (target.row - target.viewportY + 0.5) * cellHeight;
  const fromX = screen!.x + target.start * cellWidth + 1;
  const toX = screen!.x + target.end * cellWidth - 1;
  expect(y).toBeGreaterThanOrEqual(screen!.y);
  expect(y).toBeLessThanOrEqual(screen!.y + screen!.height);

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 10 });
  await page.mouse.up();
  expect(await selectionText(page)).toBe(`RX ${known}`);

  await page.keyboard.press('Control+c');
  // The clipboard is the proof where the headless browser allows the read; the copy
  // event that xterm fills is the fallback.
  await expect
    .poll(
      async () => {
        const read = await readClipboard(page);
        return read.ok
          ? read.text
          : page.evaluate(() => (window as any).__copied.at(-1) ?? '');
      },
      { timeout: ROUND_TRIP }
    )
    .toBe(`RX ${known}`);

  // With a selection the key never reaches the app: the port receives no byte.
  await page.waitForTimeout(600);
  expect(await simWritten(page, port.id)).toEqual([]);

  // Ctrl+V pastes the clipboard into the send field, and Enter sends it with LF.
  const pasted = `paste me ${port.name}`;
  const wrote = await page.evaluate(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, pasted);
  // The click focuses the terminal and clears the selection of the copied line.
  await page.locator('.jp-Terminal').click();
  expect(await selectionText(page)).toBe('');
  if (wrote) {
    await page.keyboard.press('Control+v');
  } else {
    // Headless Chromium refused the clipboard write: give xterm the same paste event.
    await page.evaluate((text: string) => {
      const textarea = document.querySelector(
        '.jp-Terminal .xterm-helper-textarea'
      ) as HTMLTextAreaElement | null;
      const data = new DataTransfer();
      data.setData('text/plain', text);
      (textarea ??
        document.querySelector('.jp-Terminal .xterm'))!.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true
        })
      );
    }, pasted);
  }
  await expect
    .poll(() => terminalText(page), { timeout: ROUND_TRIP })
    .toContain(pasted);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => simWritten(page, port.id), { timeout: ROUND_TRIP })
    .toEqual([...Buffer.from(`${pasted}\n`)]);

  // With no selection Ctrl+C reaches the app, which sends 0x03 to the port.
  await page.locator('.jp-Terminal').click({ position: { x: 10, y: 10 } });
  expect(await selectionText(page)).toBe('');
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => simWritten(page, port.id), { timeout: ROUND_TRIP })
    .toEqual([...Buffer.from(`${pasted}\n`), 0x03]);

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
  expect(help).toMatch(/PgUp +scroll the traffic view up/);
  expect(help).toMatch(/PgDn +scroll the traffic view down/);
  expect(help).toMatch(/\^c +send the byte 0x03 when no text is selected/);
  expect(help).not.toMatch(/^\s*F(?:2|3|4|6|7|8|10)\s/m);
  expect(help).not.toContain('set DTR');
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

test('ACC-TERM-255-WHEEL a mouse wheel step over the lab terminal scrolls the traffic view of the serial terminal app up, and a step down scrolls it back', async ({
  page
}) => {
  const port = simSerial();
  await openLab(page, { serial: [port] });
  await addSerial(page, port);
  await action(row(page, port.name), 'terminal').click();
  const { path } = await serialRecord(port.name);
  await expectAppHeader(page, port.name, path, TERMINAL_START);

  const lines = Array.from({ length: 80 }, (_, index) => `wheel line ${index}`);
  await simSend(page, port.id, [...Buffer.from(lines.join('\r\n') + '\r\n')]);
  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toMatch(/RX wheel line 79$/m);

  // The numbers of the traffic lines that the screen of the app shows.
  const shown = async (): Promise<number[]> =>
    [...(await terminalText(page)).matchAll(/RX wheel line (\d+)$/gm)].map(
      match => Number(match[1])
    );
  const before = await shown();
  expect(before).toContain(79);

  const screen = await page.locator('.jp-Terminal .xterm-screen').boundingBox();
  expect(screen, 'the terminal screen has a box').not.toBeNull();
  await page.mouse.move(
    screen!.x + screen!.width / 2,
    screen!.y + screen!.height / 2
  );
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => Math.min(...(await shown())), { timeout: ROUND_TRIP })
    .toBeLessThan(Math.min(...before));
  expect(await shown()).not.toContain(79);

  await page.mouse.wheel(0, 2000);
  await expect
    .poll(async () => Math.max(...(await shown())), { timeout: ROUND_TRIP })
    .toBe(79);
  // A wheel event sends keys only: the port receives no byte.
  expect(await simWritten(page, port.id)).toEqual([]);

  await page.locator('.jp-Terminal').click();
  await page.keyboard.press('Control+q');
  await expect(page.locator('.jp-Terminal')).toHaveCount(0, {
    timeout: ROUND_TRIP
  });
});
