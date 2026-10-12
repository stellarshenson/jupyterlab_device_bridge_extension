import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';
import * as path from 'path';

import {
  addSerial,
  addUsb,
  api,
  DEVICE_DIR,
  deviceDescriptorHex,
  openLab,
  PANEL_SHOWN,
  PORT,
  ROUND_TRIP,
  runCli,
  RUNTIME_DIR,
  serialRecord,
  SERVER,
  simArgs,
  simSend,
  simSerial,
  simUsb,
  simWritten,
  toolCommand,
  toolReport
} from './helpers';

/**
 * Functional tests of the shipped `jupyterlab-device` command: the installed console
 * script as a child process, the real server, the real worker in the lab tab and a
 * simulated device in the browser (device-sim.js). Nothing between the command and the
 * simulated device is replaced. Ids in the titles are the criteria of
 * docs/acc-crit-device-bridge.md.
 */

test.use({ autoGoto: false, mockSettings: PANEL_SHOWN });

const bytes = (text: string): number[] => [...Buffer.from(text)];

test.beforeAll(async () => {
  // The command finds its server with `jupyter server list`. That list must hold the
  // test server and no other. The port the command falls back on is one where nothing
  // listens (playwright.config.js), so the status below comes from that search.
  const records = fs
    .readdirSync(RUNTIME_DIR)
    .filter(file => /^jpserver-\d+\.json$/.test(file));
  expect(records).toHaveLength(1);
  const record = JSON.parse(
    fs.readFileSync(path.join(RUNTIME_DIR, records[0]), 'utf8')
  );
  expect(record.port).toBe(Number(PORT));

  const status = await runCli(['status', '--json']);
  expect(status.code, `stderr: ${status.stderr}`).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    server: SERVER,
    deviceDir: DEVICE_DIR
  });
});

test.describe('jupyterlab-device with a serial port', () => {
  test('ACC-PROF-24 the profile command sets the profile of a device and single fields', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    const result = await runCli([
      'profile',
      port.name,
      'stm32-bootloader',
      '--parity',
      'odd',
      '--baud',
      '57600'
    ]);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(
      `${port.name}: profile stm32-bootloader, overrides baudRate=57600, parity=odd, settings 57600 8O1, on open none\n`
    );
    const settings = {
      baudRate: 57600,
      dataBits: 8,
      parity: 'odd',
      stopBits: 1
    };
    expect(await serialRecord(port.name)).toMatchObject({
      profile: 'stm32-bootloader',
      overrides: { baudRate: 57600, parity: 'odd' },
      settings
    });
    // The port in the browser is open with the settings of the profile now.
    await expect
      .poll(async () => (await simArgs(page, port.id, 'open')).at(-1)?.[0], {
        timeout: ROUND_TRIP
      })
      .toMatchObject(settings);
  });

  test('ACC-SHIM-33 DTR and RTS calls of a tool started with run reach the port in the order of the tool', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);
    const { path: devicePath } = await serialRecord(port.name);

    const result = await runCli([
      'run',
      '--',
      ...toolCommand(devicePath, [
        ...['--signals', 'dtr=1', 'rts=1', 'dtr=0', 'rts=0'],
        ...['--write', '00', '--read', '1']
      ])
    ]);

    // With the shim no control line call of the tool is refused.
    expect(toolReport(result).signals).toEqual(['ok', 'ok', 'ok', 'ok']);
    await expect
      .poll(() => simArgs(page, port.id, 'setSignals'), {
        timeout: ROUND_TRIP
      })
      .toEqual([
        [{ dataTerminalReady: true, requestToSend: false }],
        [{ dataTerminalReady: true, requestToSend: true }],
        [{ dataTerminalReady: false, requestToSend: true }],
        [{ dataTerminalReady: false, requestToSend: false }]
      ]);
  });

  test('ACC-MON-39 bytes the port sent before a CLI call are printed by monitor read', async ({
    page
  }) => {
    const port = simSerial();
    const output = `boot of ${port.name}\nready\n`;
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    // The port sends while no program reads it, and the server has all of it
    // before the command is started.
    await simSend(page, port.id, bytes(output));
    await expect
      .poll(
        async () => (await api('GET', `serial/${port.name}/monitor`)).body.next,
        { timeout: ROUND_TRIP }
      )
      .toBe(output.length);

    const result = await runCli(['monitor', 'read', port.name]);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(output);
  });

  test('ACC-MON-43 monitor write sends the given bytes to the port', async ({
    page
  }) => {
    const port = simSerial();
    await openLab(page, { serial: [port] });
    await addSerial(page, port);

    const result = await runCli([
      'monitor',
      'write',
      port.name,
      'led on',
      '--newline'
    ]);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    await expect
      .poll(() => simWritten(page, port.id), { timeout: ROUND_TRIP })
      .toEqual(bytes('led on\n'));
    // The simulated port sends the bytes back, and monitor read prints them.
    await expect
      .poll(async () => (await runCli(['monitor', 'read', port.name])).stdout, {
        timeout: ROUND_TRIP
      })
      .toBe('led on\n');
  });
});

test.describe('jupyterlab-device with a USB device', () => {
  test('ACC-USB-51 usb describe lists the configurations, interfaces, endpoints and strings of a device', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    await addUsb(page, device);

    const result = await runCli(['usb', 'describe', device.name]);

    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      vendorId: device.vendorId,
      productId: device.productId,
      manufacturerName: device.manufacturerName,
      productName: device.productName,
      serialNumber: device.serialNumber,
      configurationValue: 1,
      configurations: [
        {
          configurationValue: 1,
          interfaces: [
            {
              interfaceNumber: 0,
              alternates: [
                {
                  alternateSetting: 0,
                  interfaceClass: 0xff,
                  endpoints: [
                    {
                      endpointNumber: 1,
                      direction: 'out',
                      type: 'bulk',
                      packetSize: 64
                    },
                    {
                      endpointNumber: 1,
                      direction: 'in',
                      type: 'bulk',
                      packetSize: 64
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });
  });

  test('ACC-USB-54 usb control: a transfer in returns the bytes of the device and a transfer out delivers the bytes of the caller', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    await addUsb(page, device);
    expect((await runCli(['usb', 'open', device.name])).code).toBe(0);

    // GET_DESCRIPTOR for the device descriptor: 18 bytes with the ids of the device.
    const read = await runCli([
      ...['usb', 'control', device.name],
      ...['0x80', '6', '0x0100', '0', '--length', '18']
    ]);
    expect(read.code, `stderr: ${read.stderr}`).toBe(0);
    expect(read.stdout).toBe(`${deviceDescriptorHex(device)}\n`);

    // A vendor request with two bytes of data.
    const written = await runCli([
      ...['usb', 'control', device.name],
      ...['0x40', '1', '0x0002', '0', '--data', '01ff']
    ]);
    expect(written.code, `stderr: ${written.stderr}`).toBe(0);
    expect(written.stdout).toBe('2\n');
    await expect
      .poll(() => simArgs(page, device.id, 'controlTransferOut'))
      .toEqual([
        [
          {
            requestType: 'vendor',
            recipient: 'device',
            request: 1,
            value: 2,
            index: 0
          },
          [0x01, 0xff]
        ]
      ]);
  });

  test('ACC-USB-55 usb transfer: a bulk transfer out delivers the bytes of the caller and a bulk transfer in returns the bytes of the device', async ({
    page
  }) => {
    const device = simUsb();
    await openLab(page, { usb: [device] });
    await addUsb(page, device);
    expect((await runCli(['usb', 'open', device.name])).code).toBe(0);
    expect((await runCli(['usb', 'claim', device.name, '0'])).code).toBe(0);

    const out = await runCli([
      ...['usb', 'transfer', device.name, '0x01', '--data', 'f10100']
    ]);
    expect(out.code, `stderr: ${out.stderr}`).toBe(0);
    expect(out.stdout).toBe('3\n');
    await expect
      .poll(() => simArgs(page, device.id, 'transferOut'))
      .toEqual([[1, [0xf1, 0x01, 0x00]]]);

    // The IN endpoint of the simulated device returns what its OUT endpoint got.
    const back = await runCli([
      ...['usb', 'transfer', device.name, '0x81', '--length', '64']
    ]);
    expect(back.code, `stderr: ${back.stderr}`).toBe(0);
    expect(back.stdout).toBe('f10100\n');
  });

  test('ACC-USB-60 when the browser refuses an operation the caller gets the error name and message of the browser', async ({
    page
  }) => {
    const refusal = {
      name: 'SecurityError',
      message: 'The requested interface implements a protected class.'
    };
    const device = simUsb({ fail: { claimInterface: refusal } });
    await openLab(page, { usb: [device] });
    await addUsb(page, device);
    expect((await runCli(['usb', 'open', device.name])).code).toBe(0);

    const result = await runCli(['usb', 'claim', device.name, '0']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `jupyterlab-device: ${refusal.name}: ${refusal.message}\n`
    );
    expect(await simArgs(page, device.id, 'claimInterface')).toEqual([[0]]);
  });
});
