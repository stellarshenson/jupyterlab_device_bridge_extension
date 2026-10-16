import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';
import { join } from 'path';

import { closeTerminals, openLab, PANEL_SHOWN, terminalText } from './helpers';

/**
 * Functional test of the environment selector of the device shell: the lab starts the
 * real `jupyterlab-device shell` in a terminal of the lab, and the command shows its
 * Textual list there because the start folder holds a `.venv` with an upload tool. Ids
 * in the titles are the criteria of docs/acc-crit-device-bridge.md.
 */

// The server makes the terminal, and the lab opens it by its name; see terminal.spec.ts.
test.use({ autoGoto: false, mockSettings: PANEL_SHOWN, terminals: null });

/** The terminal starts the CLI, which asks the server and shows the selector. */
const TERMINAL_START = 45000;
const QUESTION = 'Start the device shell in which environment?';

let venv = '';

test.afterEach(async () => {
  await closeTerminals();
  if (venv) {
    fs.rmSync(venv, { recursive: true, force: true });
  }
});

test('ACC-SHIM-177 Start in a folder whose .venv holds an upload tool shows the list of environments in the lab terminal, and Down then Enter starts the device shell in that .venv', async ({
  page,
  tmpPath
}) => {
  await openLab(page, {});
  // The file browser stands in the folder of the test, where the device shell starts.
  await page.evaluate(
    path =>
      (window as any).jupyterapp.commands.execute('filebrowser:go-to-path', {
        path,
        dontShowBrowser: true
      }),
    tmpPath
  );
  venv = join((await page.getServerRoot())!, tmpPath, '.venv');
  fs.mkdirSync(join(venv, 'bin'), { recursive: true });
  fs.writeFileSync(join(venv, 'bin', 'esptool'), '#!/bin/sh\necho esptool\n', {
    mode: 0o755
  });

  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute(
      'device-bridge:start-run'
    );
  });

  // The first entry keeps the current environment; the project environment comes
  // before every conda environment that the machine may have.
  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toContain(QUESTION);
  const list = await terminalText(page);
  expect(list).toMatch(/current environment/);
  expect(list).toMatch(/\.venv +project +esptool/);
  expect(list.indexOf('current environment')).toBeLessThan(
    list.indexOf('.venv')
  );

  // Focus without a click: the selector takes a click as the choice of an entry.
  await page.locator('.jp-Terminal .xterm-helper-textarea').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect
    .poll(() => terminalText(page), { timeout: TERMINAL_START })
    .toMatch(/^Environment: \.venv \(project\)\nFor esptool\.$/m);
  expect(await terminalText(page)).not.toContain(QUESTION);
});
