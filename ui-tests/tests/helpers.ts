/**
 * What the functional tests share: the simulated devices in the page, the Devices
 * panel, the settings of the plugin, the REST API of the test server, the real
 * `jupyterlab-device` command and the serial tool, both as child processes.
 */
import { expect, galata, IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { ChildProcess, spawn } from 'child_process';
import { randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Must match playwright.config.js: the one variable that moves the test server. */
export const PORT = process.env.JUPYTER_TEST_PORT || '8888';

/** Where a program in the container reaches the test server, as the CLI does. */
export const SERVER = `http://127.0.0.1:${PORT}`;

/** Must match jupyter_server_test_config.py. */
export const DEVICE_DIR = `/tmp/jupyterlab-device-galata-${PORT}`;

/** The private runtime directory that playwright.config.js gives the test server. */
export const RUNTIME_DIR = process.env.JUPYTER_RUNTIME_DIR as string;

/** How long a test waits for a second lab tab to load and restore its layout. */
export const LAB_START = 45000;

/** How long a test waits for something that needs the tab, the server and back. */
export const ROUND_TRIP = 15000;

export const PANEL = '#jupyterlab-device-bridge-panel';
export const STATUS_ITEM = '#jupyterlab-device-bridge-status';

/** The tab of the Devices panel in a sidebar of the lab; absent while the panel is hidden. */
export const PANEL_TAB = `.jp-SideBar .lm-TabBar-tab[data-id="${PANEL.slice(1)}"]`;

export const PLUGIN_ID = 'jupyterlab_device_bridge_extension:plugin';
const SETTINGS_PLUGIN = '@jupyterlab/apputils-extension:settings';

/**
 * The settings of a lab that has the Devices panel in its left sidebar from the start.
 * The panel is hidden with the default settings (setting showPanel), so a spec that
 * works in the panel passes this to `test.use({ mockSettings })`.
 *
 * Galata keeps the settings of such a page in memory and answers every settings
 * request of the page itself. So a setting a test changes never reaches the test
 * server, where it would change every later test.
 */
export const PANEL_SHOWN: Record<string, unknown> = {
  ...galata.DEFAULT_SETTINGS,
  [PLUGIN_ID]: { showPanel: true }
};

const NAMESPACE = 'jupyterlab-device-bridge-extension';
const SIMULATION = fs.readFileSync(
  path.join(__dirname, 'device-sim.js'),
  'utf8'
);
const SERIAL_TOOL = path.join(__dirname, 'serial_tool.py');
const PYTHON = process.env.PYTHON || 'python3';

export interface IErrorInfo {
  name: string;
  message: string;
}

export interface ISimSerial {
  id: string;
  /** The name the server gives the port. */
  name: string;
  usbVendorId: number;
  usbProductId: number;
  echo?: boolean;
  openError?: IErrorInfo;
}

export interface ISimUsb {
  id: string;
  /** The name the server gives the device. */
  name: string;
  vendorId: number;
  productId: number;
  serialNumber: string;
  productName: string;
  manufacturerName: string;
  fail?: Record<string, IErrorInfo>;
}

/** The argument of `installDeviceSim` in device-sim.js. */
export interface ISimConfig {
  serial?: ISimSerial[];
  usb?: ISimUsb[];
  refuse?: { serial?: IErrorInfo; usb?: IErrorInfo };
  absent?: boolean;
}

export interface ISimCall {
  realm: 'page' | 'worker';
  device: string | null;
  op: string;
  args: any[];
}

export interface ISimDialog {
  kind: 'serial' | 'usb';
  options: any;
  outcome: 'granted' | 'refused' | 'no-gesture';
  device: string | null;
}

export interface IResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const hex = (id: number): string => id.toString(16).padStart(4, '0');

/**
 * The server keeps a device name and what was set on it for its whole life, and every
 * test uses the one test server. So every test gets devices with ids of its own.
 */
const freshIds = (): [number, number] => [
  randomInt(0x1000, 0xffff),
  randomInt(0x1000, 0xffff)
];

/** A simulated serial port with USB ids that no other test uses. */
export function simSerial(extra: Partial<ISimSerial> = {}): ISimSerial {
  const [usbVendorId, usbProductId] = freshIds();
  const name = `tty-${hex(usbVendorId)}-${hex(usbProductId)}`;
  return { id: name, name, usbVendorId, usbProductId, ...extra };
}

/** A simulated USB device with ids that no other test uses. */
export function simUsb(extra: Partial<ISimUsb> = {}): ISimUsb {
  const [vendorId, productId] = freshIds();
  const name = `usb-${hex(vendorId)}-${hex(productId)}`;
  return {
    id: name,
    name,
    vendorId,
    productId,
    serialNumber: 'SIM0001',
    productName: 'Loopback',
    manufacturerName: 'Simulated Devices',
    ...extra
  };
}

/** The device descriptor that the simulated USB device answers GET_DESCRIPTOR with, as hex. */
export function deviceDescriptorHex(device: ISimUsb): string {
  const word = (value: number): number[] => [value & 0xff, value >> 8];
  return Buffer.from([
    ...[18, 1, ...word(0x0200), 0, 0, 0, 64],
    ...[...word(device.vendorId), ...word(device.productId), ...word(0x0100)],
    ...[1, 2, 3, 1]
  ]).toString('hex');
}

// ------------------------------------------------------------------ the lab page

/** Add the simulated devices to a page. Call it before the page loads the lab. */
export async function simulate(page: Page, config: ISimConfig): Promise<void> {
  await page.addInitScript({
    content: `${SIMULATION}\ninstallDeviceSim(${JSON.stringify(config)});`
  });
}

/** Open the Devices panel of the left sidebar. The setting showPanel must be true. */
export async function showPanel(page: Page): Promise<void> {
  const panel = page.locator(PANEL);
  if (!(await panel.isVisible())) {
    await page.locator(PANEL_TAB).click();
  }
  await expect(panel).toBeVisible();
}

/** Change one setting of the plugin through the setting registry of the lab, as the Settings Editor does. */
export const setSetting = (
  page: Page,
  key: string,
  value: unknown
): Promise<void> =>
  page.evaluate(
    async ([settings, plugin, name, next]) => {
      const registry = await (window as any).galata.getPlugin(settings);
      await registry.set(plugin, name, next);
    },
    [SETTINGS_PLUGIN, PLUGIN_ID, key, value] as [
      string,
      string,
      string,
      unknown
    ]
  );

/** Read one setting of the plugin from the setting registry of the lab. */
export const getSetting = (page: Page, key: string): Promise<unknown> =>
  page.evaluate(
    async ([settings, plugin, name]) => {
      const registry = await (window as any).galata.getPlugin(settings);
      return (await registry.load(plugin)).composite[name];
    },
    [SETTINGS_PLUGIN, PLUGIN_ID, key]
  );

/**
 * Load the lab with the simulated devices and open the Devices panel. The spec must
 * use the settings `PANEL_SHOWN`.
 */
export async function openLab(
  page: IJupyterLabPageFixture,
  config: ISimConfig
): Promise<void> {
  await simulate(page, config);
  await page.goto();
  await showPanel(page);
}

/**
 * Open the lab in a second tab of the same browser, which has the same grants as with
 * Chrome, and open its Devices panel.
 *
 * A page made here is outside the settings mock that Galata gives the first tab, so it
 * gets the same mock with the settings `PANEL_SHOWN`.
 *
 * It returns when that lab gave the focus to its Launcher. The lab does that when its
 * layout is restored, about 0.5 s after the panel can be clicked, and a button that was
 * clicked earlier loses the focus then. Galata waits in the same way for the first tab.
 */
export async function openSecondTab(
  page: Page,
  baseURL: string | undefined,
  config: ISimConfig
): Promise<Page> {
  const second = await page.context().newPage();
  await galata.Mock.mockSettings(second, [], { ...PANEL_SHOWN });
  await simulate(second, config);
  await second.goto(`${baseURL}/lab`);
  await expect(second.locator('.jp-Launcher')).toBeFocused({
    timeout: LAB_START
  });
  await showPanel(second);
  return second;
}

export const row = (page: Page, name: string): Locator =>
  page.locator(`${PANEL} [data-device="${name}"]`);

export const field = (root: Locator, name: string): Locator =>
  root.locator(`[data-field="${name}"]`);

export const action = (root: Locator | Page, name: string): Locator =>
  root.locator(`[data-action="${name}"]`);

/**
 * The toast of the lab that shows this text. The lab cuts a text after 140 characters,
 * and it displays no toast for a notification that it only adds to its list.
 */
export const toast = (page: Page, text: string): Locator =>
  page.locator('.Toastify__toast').filter({ hasText: text });

/** Forget a device with the two clicks its button asks for. */
export async function forget(deviceRow: Locator): Promise<void> {
  const button = action(deviceRow, 'forget');
  await button.click();
  await expect(button).toHaveText('Confirm forget');
  // The second click counts 500 ms after the first, so a double click does not confirm.
  await deviceRow.page().waitForTimeout(600);
  await button.click();
}

/**
 * What the simulation recorded: every call on a simulated device by the worker of any
 * tab of the browser, and every WebSocket this page and those workers made, in order.
 */
export const simCalls = (page: Page, device?: string): Promise<ISimCall[]> =>
  page.evaluate(
    wanted =>
      (window as any).__deviceSim.calls.filter(
        (call: ISimCall) => wanted === null || call.device === wanted
      ),
    device ?? null
  );

/** The arguments of every call of one operation on a simulated device, in order. */
export const simArgs = async (
  page: Page,
  device: string,
  op: string
): Promise<any[][]> =>
  (await simCalls(page, device))
    .filter(call => call.op === op)
    .map(call => call.args);

/** Every byte written to a simulated serial port so far. */
export const simWritten = async (
  page: Page,
  device: string
): Promise<number[]> =>
  (await simArgs(page, device, 'write')).flatMap(([bytes]) => bytes);

export const simDialogs = (page: Page): Promise<ISimDialog[]> =>
  page.evaluate(() => (window as any).__deviceSim.dialogs);

export const simGrants = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as any).__deviceSim.grants());

/** The simulated serial port sends these bytes on its own. */
export const simSend = (
  page: Page,
  device: string,
  bytes: number[]
): Promise<void> =>
  page.evaluate(([id, data]) => (window as any).__deviceSim.send(id, data), [
    device,
    bytes
  ] as [string, number[]]);

/**
 * The simulated serial port sends these bytes `count` times, `interval` ms apart, each
 * time as one chunk. The worker keeps the times, so they do not wait while the page draws.
 */
export const simStream = (
  page: Page,
  device: string,
  bytes: number[],
  count: number,
  interval: number
): Promise<void> =>
  page.evaluate(
    ([id, data, times, apart]) =>
      (window as any).__deviceSim.stream(id, data, times, apart),
    [device, bytes, count, interval] as [string, number[], number, number]
  );

/**
 * The text of every terminal of the lab. A lab terminal draws on a canvas, so the
 * text is read from the buffer of the terminal emulator and not from the document.
 *
 * A line that is longer than the terminal is wide fills several rows. Those rows are
 * joined to the one line again, so the text does not depend on the width of the
 * terminal.
 */
export const terminalText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const lines: string[] = [];
    for (const widget of (window as any).jupyterapp.shell.widgets('main')) {
      const buffer = widget.content?._term?.buffer.active;
      for (let index = 0; buffer && index < buffer.length; index++) {
        const row = buffer.getLine(index);
        // The spaces at the end of a row belong to its line when the next row continues it.
        const text = row.translateToString(false);
        if (row.isWrapped && lines.length > 0) {
          lines[lines.length - 1] += text;
        } else {
          lines.push(text);
        }
      }
    }
    return lines.map(line => line.trimEnd()).join('\n');
  });

/**
 * Wait until a lab terminal shows the header of the serial terminal app on a port.
 * The app draws the header with one column of padding on the left and wraps it at
 * the end of a word where the terminal is narrower than the header. So the first row
 * opens with the name of the app and of the port, and the path of the device follows
 * on that row or on a later one.
 */
export async function expectAppHeader(
  page: Page,
  name: string,
  devicePath: string,
  timeout: number
): Promise<void> {
  await expect
    .poll(() => terminalText(page), { timeout })
    .toMatch(new RegExp(`^ ?jupyterlab-device terminal · ${name}\\s`));
  const escaped = devicePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(await terminalText(page)).toMatch(new RegExp(`${escaped}\\s+·`));
}

/** One change of a lamp of a device row from off to lit or back, as `recordLamps` records it. */
export interface ILampEvent {
  /** The name of the device of the row. */
  device: string | null;
  lamp: 'tx' | 'rx';
  /** Whether the lamp is lit after the change. */
  lit: boolean;
  /** The colour of the circle of the lamp after the change. */
  colour: string;
  /** Milliseconds since the page loaded. */
  at: number;
}

/**
 * Record in the page every change of a lamp of the Devices panel from off to lit and
 * back, from the start of each document. The lab lights a lamp for 200 ms from each
 * event, and a test that looks at the lamp now and then misses that time. An event
 * that comes while the lamp is lit keeps it lit and is no change. Call it before the
 * page loads the lab; with a browser context it records in every page of the context.
 */
export async function recordLamps(
  target: Page | BrowserContext
): Promise<void> {
  await target.addInitScript(() => {
    const events: object[] = [];
    (window as any).__lampEvents = events;
    /** The lamps that are lit, as far as recorded. */
    const lit = new WeakSet<Element>();
    const note = (lamp: Element): void => {
      const now = lamp.hasAttribute('data-lit');
      if (now === lit.has(lamp)) {
        return;
      }
      if (now) {
        lit.add(lamp);
      } else {
        lit.delete(lamp);
      }
      events.push({
        device:
          lamp.closest('[data-device]')?.getAttribute('data-device') ?? null,
        lamp: lamp.getAttribute('data-lamp'),
        lit: now,
        colour: getComputedStyle(lamp, '::before').backgroundColor,
        at: performance.now()
      });
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          note(record.target as Element);
        }
        // A lamp that is lit already when its row enters the document.
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) {
            node.querySelectorAll('[data-lamp][data-lit]').forEach(note);
          }
        }
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-lit']
    });
  });
}

/** Every change of a lamp of the row of this device since the page loaded, in order. */
export const lampEvents = (page: Page, device: string): Promise<ILampEvent[]> =>
  page.evaluate(
    name =>
      (window as any).__lampEvents.filter(
        (event: ILampEvent) => event.device === name
      ),
    device
  );

/** The runs section of the Devices panel: the device shells and the tools under `jupyterlab-device run`. */
export const runsSection = (page: Page): Locator =>
  page.locator(`${PANEL} [data-section="runs"]`);

/** The row of the run with this process id in the Devices panel. */
export const runRow = (page: Page, pid: number): Locator =>
  runsSection(page).locator(`[data-run="${pid}"]`);

/**
 * Wait for something that only happens while a child process runs. A child that
 * ends first fails the wait at once with its own message, which names the cause.
 */
export async function whileRunning(
  child: IChild,
  wait: Promise<void>
): Promise<void> {
  const endedEarly = child.done.then(result => {
    throw new Error(
      `the command ended early with status ${result.code}\nstderr: ${result.stderr}`
    );
  });
  // Promise.race takes the rejection of the one that loses too.
  await Promise.race([wait, endedEarly]);
}

/** The simulated device leaves the computer, as when the user pulls its cable. */
export const simUnplug = (page: Page, device: string): Promise<void> =>
  page.evaluate(id => (window as any).__deviceSim.unplug(id), device);

/** A simulated serial port with an `openError` opens from now on; returns when the worker knows. */
export async function simAllowOpen(page: Page, device: string): Promise<void> {
  await page.evaluate(id => (window as any).__deviceSim.allowOpen(id), device);
  await expect.poll(() => simArgs(page, device, 'allowOpen')).toEqual([[]]);
}

// -------------------------------------------------------------- the test server

/** Call the REST API of the device bridge on the test server. */
export async function api(
  method: string,
  route: string,
  body?: object
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${SERVER}/${NAMESPACE}/${route}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/** The record of a serial device in the table of the server; undefined when it has none. */
export async function serialRecord(name: string): Promise<any> {
  const table = (await api('GET', 'devices')).body;
  return table.serial.find((record: any) => record.name === name);
}

/** The record of a USB device in the table of the server; undefined when it has none. */
export async function usbRecord(name: string): Promise<any> {
  const table = (await api('GET', 'devices')).body;
  return table.usb.find((record: any) => record.name === name);
}

/** The process id of every run the server lists. */
export const runPids = async (): Promise<number[]> =>
  (await api('GET', 'runs')).body.runs.map((run: { pid: number }) => run.pid);

/** The plus icon in the header of the Devices panel: the one control of the panel that adds a device. */
export const addIcon = (page: Page): Locator =>
  page.locator(`${PANEL} [data-action="add-device"]`);

/** The menu that the plus icon opens. The lab attaches an open menu to the body of the page. */
export const addMenu = (page: Page): Locator => page.locator('body > .lm-Menu');

/** The entry of the plus menu that connects a device of this kind. */
export const addMenuEntry = (page: Page, kind: 'serial' | 'usb'): Locator =>
  addMenu(page).locator(
    `.lm-Menu-item[data-command="device-bridge:connect-${kind}"]`
  );

/**
 * Add a device as the user does: click the plus icon of the panel, then the entry of
 * its menu for this kind of device. The entry opens the dialog of the browser.
 */
export async function pickAddEntry(
  page: Page,
  kind: 'serial' | 'usb'
): Promise<void> {
  await addIcon(page).click();
  await addMenuEntry(page, kind).click();
}

/** Pick Connect Serial Port in the plus menu and wait until the tab holds the open port. */
export async function addSerial(page: Page, port: ISimSerial): Promise<void> {
  await pickAddEntry(page, 'serial');
  await expect
    .poll(async () => (await serialRecord(port.name))?.portState, {
      timeout: ROUND_TRIP
    })
    .toBe('open');
  await expect(row(page, port.name)).toHaveAttribute('data-owner', 'this');
}

/** Pick Connect USB Device in the plus menu and wait until the tab holds the device. */
export async function addUsb(page: Page, device: ISimUsb): Promise<void> {
  await pickAddEntry(page, 'usb');
  await expect
    .poll(async () => (await usbRecord(device.name))?.state, {
      timeout: ROUND_TRIP
    })
    .toBe('attached');
  await expect(row(page, device.name)).toHaveAttribute('data-owner', 'this');
}

// ------------------------------------------------------------ child processes

/**
 * The variables the CLI would reach another server with when its own search finds
 * none. playwright.config.js gives every child the private runtime directory and
 * removes these; they are removed here too, and the port to fall back on is one where
 * nothing listens, so a search that fails ends with an error and never at another lab.
 */
const DISCOVERY_ENV = [
  'JUPYTERHUB_API_TOKEN',
  'JPY_API_TOKEN',
  'JUPYTER_TOKEN',
  'JUPYTERHUB_SERVICE_PREFIX'
];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, JUPYTER_PORT: '1' };
  for (const name of DISCOVERY_ENV) {
    delete env[name];
  }
  return env;
}

/** A child process, its stdin and its result. */
export interface IChild {
  process: ChildProcess;
  /** Resolves when the child ended; it never rejects. */
  done: Promise<IResult>;
  /** Resolves with the first line the child printed on stdout. */
  firstLine: Promise<string>;
}

function start(command: string, args: string[]): IChild {
  const child = spawn(command, args, { env: childEnv() });
  let gotLine: (line: string) => void;
  const firstLine = new Promise<string>(resolve => (gotLine = resolve));
  const done = new Promise<IResult>(resolve => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
      stdout += data.toString();
      if (stdout.includes('\n')) {
        gotLine(stdout.split('\n')[0]);
      }
    });
    child.stderr.on('data', data => (stderr += data.toString()));
    // Without this a command that is not installed stops the whole worker.
    child.on('error', error =>
      resolve({ code: null, stdout, stderr: `${stderr}spawn failed: ${error}` })
    );
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { process: child, done, firstLine };
}

/** Start the real `jupyterlab-device` command. The promise is the caller's to await. */
export function startCli(args: string[]): IChild {
  return start('jupyterlab-device', args);
}

/**
 * End every terminal of the test server and wait until it has none. The lab starts a
 * device shell and the serial terminal through the basic terminal extension. Galata
 * ends only the terminals that a page made with the terminals API of the lab, so a
 * spec that starts one calls this in `afterEach`. The programs of a terminal end with
 * it. Every terminal of the test server belongs to the test that runs: the suite has
 * one worker.
 */
export async function closeTerminals(): Promise<void> {
  const names = async (): Promise<string[]> =>
    (await (await fetch(`${SERVER}/api/terminals`)).json()).map(
      (terminal: { name: string }) => terminal.name
    );
  await Promise.all(
    (await names()).map(name =>
      fetch(`${SERVER}/api/terminals/${name}`, { method: 'DELETE' })
    )
  );
  await expect.poll(names, { timeout: ROUND_TRIP }).toEqual([]);
}

/**
 * End the processes a test started and wait until each is gone and the server lists
 * none of them as a run. A test calls it in `afterEach`, so it runs after a failure too.
 *
 * @param pids The process ids: of a child of the test, or of a run the test started
 */
export async function endProcesses(pids: number[]): Promise<void> {
  for (const pid of pids) {
    // Process 1 is the first process of the container, and no test starts it.
    if (pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process ended before.
      }
    }
  }
  await expect
    .poll(
      async () => [
        pids.filter(pid => fs.existsSync(`/proc/${pid}`)),
        (await runPids()).filter(pid => pids.includes(pid))
      ],
      { timeout: ROUND_TRIP }
    )
    .toEqual([[], []]);
}

/** Run the real `jupyterlab-device` command to its end. */
export async function runCli(args: string[]): Promise<IResult> {
  const child = startCli(args);
  child.process.stdin!.end();
  return child.done;
}

/** The command line of the serial tool on a device path. */
export const toolCommand = (devicePath: string, args: string[]): string[] => [
  PYTHON,
  SERIAL_TOOL,
  devicePath,
  ...args
];

/** Start the serial tool on a device path, without the preload shim. */
export function startTool(devicePath: string, args: string[]): IChild {
  const [command, ...rest] = toolCommand(devicePath, args);
  return start(command, rest);
}

/** What the serial tool printed: the outcome of each control line call and the bytes it read. */
export function toolReport(result: IResult): {
  signals: string[];
  read: number[];
} {
  expect(result.code, `stderr: ${result.stderr}`).toBe(0);
  const report = JSON.parse(result.stdout);
  return {
    signals: report.signals,
    read: [...Buffer.from(report.read, 'hex')]
  };
}
