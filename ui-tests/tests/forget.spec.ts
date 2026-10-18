import { expect, test } from '@jupyterlab/galata';

import {
  field,
  forget,
  openLab,
  PANEL_SHOWN,
  pickAddEntry,
  ROUND_TRIP,
  row,
  serialRecord,
  simCalls,
  simGrants,
  simSerial,
  simWritten,
  startTool,
  toolReport
} from './helpers';

/**
 * A forget of a serial port whose browser port is open while the worker believes it
 * is closed. The simulator's openError refuses the open while the browser port stays
 * closed, so the test wraps the worker of the lab: the first open of the port succeeds
 * in the simulator and then fails for the worker. That is the state one board left
 * behind, and the state that made Forget leave the port open.
 */

/**
 * In the worker: the first open of a port succeeds in the browser and then rejects.
 * The wrapper is added to the source of the worker the lab starts (see the init script
 * below), so it holds before the worker reads its first message.
 */
function stuckFirstOpen(): void {
  const serial = (navigator as any).serial;
  if (!serial) {
    return;
  }
  const getPorts = serial.getPorts.bind(serial);
  let first = true;
  serial.getPorts = async (): Promise<any[]> => {
    const ports = await getPorts();
    return ports.map(
      (target: any) =>
        new Proxy(target, {
          get(object: any, property: string | symbol): any {
            if (property === 'open') {
              return async (options: any): Promise<void> => {
                await object.open(options);
                if (first) {
                  first = false;
                  throw new DOMException(
                    'Failed to open serial port.',
                    'NetworkError'
                  );
                }
              };
            }
            const value = object[property];
            return typeof value === 'function' ? value.bind(object) : value;
          }
        })
    );
  };
}

/**
 * The init script of the page: wrap `Worker` so that a worker started from a Blob URL
 * first runs the code of the simulator and the lab, then this patch. The simulator
 * wraps `Worker` itself in a later init script, and calls this wrapper to start the
 * worker of the lab.
 */
const STUCK_WORKER = `
(() => {
  const Native = window.Worker;
  const patch = ${JSON.stringify(`(${stuckFirstOpen.toString()})();`)};
  window.Worker = function (url, options) {
    if ((options && options.type === 'module') || !String(url).startsWith('blob:')) {
      return new Native(url, options);
    }
    const text = 'importScripts(' + JSON.stringify(String(url)) + ');' + patch;
    return new Native(
      URL.createObjectURL(new Blob([text], { type: 'text/javascript' })),
      options
    );
  };
  window.Worker.prototype = Native.prototype;
})();
`;

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

test('DEF-SERIAL-26 Forget closes the serial port the browser still holds open, and the port attaches and moves bytes again in the same page', async ({
  page
}) => {
  await page.addInitScript({ content: STUCK_WORKER });
  const port = simSerial();
  await openLab(page, { serial: [port] });

  // The attach opens the port in the browser, and the worker is told the open failed.
  // `pickAddEntry` is the plus menu entry Connect Serial Port of the panel.
  await pickAddEntry(page, 'serial');
  const reason = 'Failed to open serial port.';
  await expect(field(row(page, port.name), 'error')).toHaveText(reason, {
    timeout: ROUND_TRIP
  });
  expect(await serialRecord(port.name)).toMatchObject({
    state: 'attached',
    portState: 'error',
    error: reason
  });
  // The simulator holds the port open; the worker has not closed it.
  const operations = async (): Promise<string[]> =>
    (await simCalls(page, port.id))
      .filter(call => call.realm === 'worker')
      .map(call => call.op);
  expect(await operations()).toEqual(['open']);

  // Forget must close the port the worker believes it does not hold, before it
  // revokes the grant. Without the close the browser keeps the port, and the next
  // open of the port fails with "The port is already open.".
  await forget(row(page, port.name));
  await expect(row(page, port.name)).toHaveCount(0, { timeout: ROUND_TRIP });
  await expect
    .poll(operations, { timeout: ROUND_TRIP })
    .toEqual(['open', 'close', 'forget']);
  expect(await simGrants(page)).toEqual([]);
  expect(await serialRecord(port.name)).toBeUndefined();

  // The grant is given again and the port attaches in the same page, without error.
  await pickAddEntry(page, 'serial');
  await expect
    .poll(async () => (await serialRecord(port.name))?.portState, {
      timeout: ROUND_TRIP
    })
    .toBe('open');
  await expect(row(page, port.name)).toHaveAttribute('data-owner', 'this');
  await expect(field(row(page, port.name), 'error')).toBeHidden();

  // Bytes reach the port of the new grant, and the port gives them back.
  const { path } = await serialRecord(port.name);
  const tool = startTool(path, ['--write', '3020', '--read', '2']);
  toolReport(await tool.done);
  expect(await simWritten(page, port.id)).toEqual([0x30, 0x20]);
});
