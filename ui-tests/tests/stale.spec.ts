import { expect, galata, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  addSerial,
  api,
  DEVICE_DIR,
  field,
  hex,
  LAB_START,
  openLab,
  PANEL_SHOWN,
  pickAddEntry,
  ROUND_TRIP,
  row,
  serialRecord,
  showPanel,
  simSerial,
  simulate,
  simUsb
} from './helpers';

/**
 * Functional tests of the removal of stale devices: device entries in the device
 * directory that no record of the bridge accounts for. They are placed in the device
 * directory of a test server, and the bridge removes them when it starts and when a
 * lab tab connects. Ids in the titles are the criteria of docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

const PYTHON = process.env.PYTHON || 'python3';

interface ISeeded {
  /** Device entries that no record accounts for: they must go. */
  stale: string[];
  /** The names of the devices the stale entries look like: the panel must not list them. */
  names: string[];
  /** Entries that are no device entry: they must stay. */
  others: string[];
}

/**
 * Place stale device entries and entries that are no device entry in a device
 * directory: a symlink to a pty slave, symlinks named tty-* and usb-* that lead to no
 * device, a socket in .shim, then a regular file, a directory and a symlink of another
 * name. The names come from fresh ids, so no device of another test has them.
 */
function seed(directory: string): ISeeded {
  const shim = path.join(directory, '.shim');
  fs.mkdirSync(shim, { recursive: true, mode: 0o700 });
  const serial = simSerial().name;
  const usb = simUsb().name;
  const port = `tty-port-${hex(simSerial().usbVendorId)}`;
  const links: [string, string][] = [
    [serial, '/dev/pts/stale'],
    [usb, '/dev/bus/usb/001/099'],
    [port, '/tmp/jupyterlab-device-gone']
  ];
  const stale = links.map(([name, target]) => {
    const entry = path.join(directory, name);
    fs.symlinkSync(target, entry);
    return entry;
  });
  // A Unix socket as a killed server leaves it: Node removes the socket file of a
  // server it closes, so a child binds it and ends without removing it.
  const socket = path.join(
    shim,
    `pts-stale-${hex(simSerial().usbVendorId)}.sock`
  );
  execFileSync(PYTHON, [
    '-c',
    'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])',
    socket
  ]);
  stale.push(socket);
  const id = hex(simSerial().usbVendorId);
  const others = [
    path.join(directory, `notes-${id}.txt`),
    path.join(directory, `folder-${id}`),
    path.join(directory, `link-${id}`),
    path.join(shim, `file-${id}`)
  ];
  fs.writeFileSync(others[0], 'not a device');
  fs.mkdirSync(others[1]);
  fs.symlinkSync(os.tmpdir(), others[2]);
  fs.writeFileSync(others[3], 'not a socket');
  return { stale, names: links.map(([name]) => name), others };
}

/** The entries of a list that exist in the file system, symlinks counted as they are. */
const present = (entries: string[]): string[] =>
  entries.filter(entry => {
    try {
      fs.lstatSync(entry);
      return true;
    } catch {
      return false;
    }
  });

/** Remove what a test placed, also when the bridge did not remove it. */
const unseed = (seeded: ISeeded | undefined): void => {
  for (const entry of [...(seeded?.stale ?? []), ...(seeded?.others ?? [])]) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
};

/** The paths of the device table of a server: the link of every serial record. */
const tablePaths = (table: { serial: { path: string }[] }): string[] =>
  table.serial.map(record => record.path);

/** Reload the page and wait until its new tab holds the port open again. */
async function reload(page: Page, name: string): Promise<void> {
  const before = (await serialRecord(name)).tab;
  await page.reload();
  await expect
    .poll(
      async () => {
        const record = await serialRecord(name);
        return record.tab !== before && record.portState;
      },
      { timeout: ROUND_TRIP }
    )
    .toBe('open');
}

test.describe('stale devices', () => {
  let seeded: ISeeded | undefined;

  test.afterEach(() => {
    unseed(seeded);
    seeded = undefined;
  });

  test('ACC-SERIAL-252-TABSWEEP a lab tab that connects removes the device entries no record accounts for and keeps every entry of the table and every entry that is no device entry', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const shim = path.join(DEVICE_DIR, '.shim');
    // Every socket here belongs to a device of the table: the tab that just connected swept the rest.
    const known = [
      ...tablePaths((await api('GET', 'devices')).body),
      ...fs.readdirSync(shim).map(name => path.join(shim, name))
    ];
    expect(known.length).toBeGreaterThan(1);
    seeded = seed(DEVICE_DIR);

    await reload(page, port.name);

    await expect
      .poll(() => present(seeded!.stale), { timeout: ROUND_TRIP })
      .toEqual([]);
    expect(present(seeded.others)).toEqual(seeded.others);
    expect(present(known)).toEqual(known);
    const table = (await api('GET', 'devices')).body;
    expect(present(tablePaths(table))).toEqual(tablePaths(table));
  });

  test('ACC-SERIAL-253-SWEEPPANEL after a page load the panel lists no removed stale device, and the attached port keeps its row, its owner and its link', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const link = (await serialRecord(port.name)).path;
    const target = fs.readlinkSync(link);
    seeded = seed(DEVICE_DIR);

    await reload(page, port.name);

    await expect
      .poll(() => present(seeded!.stale), { timeout: ROUND_TRIP })
      .toEqual([]);
    await showPanel(page);
    const portRow = row(page, port.name);
    await expect(portRow).toHaveAttribute('data-owner', 'this');
    await expect(field(portRow, 'state')).toHaveText('attached');
    for (const name of seeded.names) {
      await expect(row(page, name)).toHaveCount(0);
    }
    expect(fs.readlinkSync(link)).toBe(target);
    expect(target.startsWith('/dev/pts/')).toBe(true);
  });

  test.describe('a second server', () => {
    let server: ChildProcess | undefined;
    let runtime: string | undefined;
    let directory: string | undefined;

    test.afterEach(async () => {
      if (server && server.exitCode === null && server.signalCode === null) {
        const ended = new Promise(resolve => server!.once('exit', resolve));
        server.kill('SIGTERM');
        const killed = setTimeout(() => server!.kill('SIGKILL'), 30000);
        await ended;
        clearTimeout(killed);
      }
      for (const scratch of [runtime, directory]) {
        if (scratch) {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
      server = runtime = directory = undefined;
    });

    test('ACC-SERIAL-251-STARTSWEEP a server that starts on a device directory removes the device entries a killed server left and keeps the rest; a port added there gets its row and its link', async ({
      page
    }) => {
      test.setTimeout(240000);
      const port2 = await new Promise<number>(resolve => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = probe.address() as net.AddressInfo;
          probe.close(() => resolve(port));
        });
      });
      // The same path as in jupyter_server_test_config.py for that port.
      directory = `/tmp/jupyterlab-device-galata-${port2}`;
      fs.mkdirSync(directory, { mode: 0o700 });
      seeded = seed(directory);
      // A runtime directory of its own, so that the CLI of the other specs lists one server.
      runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'galata-second-'));
      server = spawn(
        'jupyter',
        ['lab', '--config', 'jupyter_server_test_config.py'],
        {
          cwd: path.join(__dirname, '..'),
          env: {
            ...process.env,
            JUPYTER_TEST_PORT: String(port2),
            JUPYTER_RUNTIME_DIR: runtime
          },
          stdio: 'ignore'
        }
      );
      const base = `http://127.0.0.1:${port2}`;
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(`${base}/lab`)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 120000, intervals: [500] }
        )
        .toBe(200);

      expect(present(seeded.stale)).toEqual([]);
      expect(present(seeded.others)).toEqual(seeded.others);
      expect(fs.statSync(path.join(directory, '.shim')).isDirectory()).toBe(
        true
      );

      const port = simSerial();
      const second = await page.context().newPage();
      await galata.Mock.mockSettings(second, [], { ...PANEL_SHOWN });
      await simulate(second, { serial: [port] });
      await second.goto(`http://localhost:${port2}/lab`);
      await expect(second.locator('.jp-Launcher')).toBeFocused({
        timeout: LAB_START
      });
      await showPanel(second);
      await pickAddEntry(second, 'serial');
      const record = async (): Promise<any> =>
        (
          await (
            await fetch(`${base}/jupyterlab-device-bridge-extension/devices`)
          ).json()
        ).serial.find((device: any) => device.name === port.name);
      await expect
        .poll(async () => (await record())?.portState, { timeout: ROUND_TRIP })
        .toBe('open');
      await expect(row(second, port.name)).toHaveAttribute(
        'data-owner',
        'this'
      );
      for (const name of seeded.names) {
        await expect(row(second, name)).toHaveCount(0);
      }
      const link = path.join(directory, port.name);
      expect((await record()).path).toBe(link);
      expect(fs.readlinkSync(link).startsWith('/dev/pts/')).toBe(true);
      await second.close();
    });
  });
});
