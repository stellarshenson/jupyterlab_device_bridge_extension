/**
 * Simulated serial ports and USB devices for the functional tests.
 *
 * `installDeviceSim(config)` defines `navigator.serial` and `navigator.usb` in the
 * realm it runs in. A spec adds this file to the page as an init script (helpers.ts).
 * An init script does not run in a worker, so in the page the function also wraps
 * `Worker`: a worker started from a Blob URL first runs this function and then loads
 * the real Blob with `importScripts`. The function is self-contained, because its own
 * text is what the worker gets.
 *
 * The page side and the worker side share one state over a BroadcastChannel:
 *
 *   page side    holds the grants and opens the grant dialogs. The grants are in
 *                localStorage: they stay over a page load and every tab of the browser
 *                sees them, as with a permission of Chrome.
 *   worker side  holds the device objects the bridge opens. It asks the page side
 *                for the grants on every listing and reports every call on a device.
 *
 * What a test sets (`config`):
 *
 *   serial   [{ id, usbVendorId?, usbProductId?, echo?, openError? }]
 *            `echo` (default true): the port sends back every byte written to it.
 *            `openError` ({ name, message }): the port refuses to open with this error.
 *   usb      [{ id, vendorId, productId, serialNumber?, productName?,
 *              manufacturerName?, fail? }]
 *            One vendor interface 0 with a bulk OUT 1 and a bulk IN 1 endpoint; IN
 *            returns what OUT got. The control endpoint answers GET_DESCRIPTOR.
 *            `fail` ({ <WebUSB method>: { name, message } }): that method is refused.
 *   refuse   { serial?: { name, message }, usb?: { name, message } }
 *            The grant dialog of that kind fails with this error.
 *   absent   true removes both interfaces, as on a page that is no secure context.
 *
 * What a test reads and does in the page (`window.__deviceSim`):
 *
 *   calls            every call on a simulated device and every WebSocket made, in
 *                    order: { realm: 'page' | 'worker', device: id | null, op, args }.
 *                    Bytes are arrays of numbers.
 *   dialogs          every grant dialog call: { kind, options, outcome, device } with
 *                    outcome 'granted', 'refused' or 'no-gesture'
 *   grants()         the ids of the granted devices
 *   send(id, bytes)  the serial port sends these bytes on its own
 *   stream(id, bytes, count, interval)
 *                    the serial port sends these bytes `count` times, `interval` ms
 *                    apart, each time as one chunk of its read stream. The worker
 *                    keeps the times, so they do not wait while the page draws
 *   unplug(id)       the device leaves the computer: the browser lists it no longer
 *                    and fires `disconnect`
 *   allowOpen(id)    the serial port loses its `openError`: its next `open()` works.
 *                    The worker records the call `allowOpen` when that is done
 *
 * A worker has `self.__deviceSim.calls` with its own calls.
 */
function installDeviceSim(config) {
  const CHANNEL = 'device-sim';
  const GRANTS_KEY = 'device-sim-grants';
  const GET_DESCRIPTOR = 6;
  const scope = globalThis;
  const inPage = typeof document !== 'undefined';
  // The first document of a new tab is about:blank, which has no storage.
  if (inPage && !scope.location.protocol.startsWith('http')) {
    return;
  }
  const channel = new BroadcastChannel(CHANNEL);
  const sim = { calls: [] };
  scope.__deviceSim = sim;

  /** A value as a test reads it: without members that are undefined. */
  const plain = value =>
    value === undefined ? null : JSON.parse(JSON.stringify(value));
  const fail = error => new DOMException(error.message, error.name);
  const record = (device, op, args) => {
    const call = {
      realm: inPage ? 'page' : 'worker',
      device,
      op,
      args: plain(args)
    };
    sim.calls.push(call);
    if (!inPage) {
      channel.postMessage({ type: 'call', call });
    }
  };

  const NativeWebSocket = scope.WebSocket;
  scope.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      record(null, 'websocket', [String(url)]);
    }
  };

  if (inPage) {
    const NativeWorker = scope.Worker;
    const simulation = `${installDeviceSim.toString()}\ninstallDeviceSim(${JSON.stringify(config)});\n`;
    scope.Worker = function (url, options) {
      const classic = !options || options.type !== 'module';
      if (!classic || !String(url).startsWith('blob:')) {
        return new NativeWorker(url, options);
      }
      const text = `${simulation}importScripts(${JSON.stringify(String(url))});`;
      const blob = new Blob([text], { type: 'text/javascript' });
      return new NativeWorker(URL.createObjectURL(blob), options);
    };
    scope.Worker.prototype = NativeWorker.prototype;
  }

  if (config.absent) {
    const prototype = Object.getPrototypeOf(scope.navigator);
    delete prototype.serial;
    delete prototype.usb;
    return;
  }
  const define = (name, value) =>
    Object.defineProperty(scope.navigator, name, { value, configurable: true });
  const serialInfo = port =>
    port.usbVendorId === undefined
      ? {}
      : { usbVendorId: port.usbVendorId, usbProductId: port.usbProductId };

  // ------------------------------------------------------------------- page side

  if (inPage) {
    const readGrants = () =>
      JSON.parse(scope.localStorage.getItem(GRANTS_KEY) || '[]');
    const writeGrants = ids =>
      scope.localStorage.setItem(GRANTS_KEY, JSON.stringify(ids));
    sim.dialogs = [];
    sim.grants = readGrants;
    sim.send = (id, bytes) =>
      channel.postMessage({ type: 'send', id, bytes: Array.from(bytes) });
    sim.stream = (id, bytes, count, interval) =>
      channel.postMessage({
        type: 'stream',
        id,
        bytes: Array.from(bytes),
        count,
        interval
      });
    sim.unplug = id => channel.postMessage({ type: 'unplug', id });
    sim.allowOpen = id => channel.postMessage({ type: 'allow-open', id });

    channel.onmessage = event => {
      const message = event.data;
      if (message.type === 'list') {
        channel.postMessage({
          type: 'grants',
          worker: message.worker,
          query: message.query,
          ids: readGrants()
        });
      } else if (message.type === 'call') {
        sim.calls.push(message.call);
      } else if (message.type === 'forget') {
        writeGrants(readGrants().filter(id => id !== message.id));
      }
    };

    /** One grant dialog: the user picks the first offered device that has no grant yet. */
    const ask = (kind, options, offered) => {
      const dialog = {
        kind,
        options: plain(options),
        outcome: 'no-gesture',
        device: null
      };
      sim.dialogs.push(dialog);
      // Chrome opens a grant dialog only while a user gesture is active.
      if (!scope.navigator.userActivation.isActive) {
        throw new DOMException(
          'Must be handling a user gesture to show a permission request.',
          'SecurityError'
        );
      }
      dialog.outcome = 'refused';
      const refusal = (config.refuse || {})[kind];
      if (refusal) {
        throw fail(refusal);
      }
      const granted = readGrants();
      const picked = (config[kind] || []).find(
        device => !granted.includes(device.id) && offered(device)
      );
      if (!picked) {
        // A dialog that offers no device ends as a dialog the user closed.
        throw new DOMException('No device selected.', 'NotFoundError');
      }
      writeGrants([...granted, picked.id]);
      dialog.outcome = 'granted';
      dialog.device = picked.id;
      return picked;
    };
    /** A filter field that is absent matches every device. */
    const same = (wanted, actual) => wanted === undefined || wanted === actual;
    const filtersOf = options => (options && options.filters) || [];

    define('serial', {
      requestPort: async options => {
        const filters = filtersOf(options);
        const port = ask(
          'serial',
          options,
          device =>
            filters.length === 0 ||
            filters.some(
              filter =>
                same(filter.usbVendorId, device.usbVendorId) &&
                same(filter.usbProductId, device.usbProductId)
            )
        );
        return { getInfo: () => serialInfo(port) };
      }
    });
    define('usb', {
      requestDevice: async options => {
        const filters = filtersOf(options);
        const device = ask(
          'usb',
          options,
          offered =>
            filters.length === 0 ||
            filters.some(
              filter =>
                same(filter.vendorId, offered.vendorId) &&
                same(filter.productId, offered.productId)
            )
        );
        return {
          vendorId: device.vendorId,
          productId: device.productId,
          serialNumber: device.serialNumber,
          productName: device.productName,
          manufacturerName: device.manufacturerName
        };
      }
    });
    return;
  }

  // ----------------------------------------------------------------- worker side

  const worker = Math.random().toString(16).slice(2);
  const answers = new Map();
  let queries = 0;
  /** The ids of the granted devices, asked of the page side every time. */
  const granted = () =>
    new Promise(resolve => {
      queries += 1;
      answers.set(queries, resolve);
      channel.postMessage({ type: 'list', worker, query: queries });
    });
  const forgetGrant = (made, id) => {
    made.delete(id);
    channel.postMessage({ type: 'forget', id });
  };
  const bytesOf = data => {
    if (!data) {
      return [];
    }
    return Array.from(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  };
  const ports = new Map();
  const devices = new Map();
  const unplugged = new Set();

  const makePort = port => {
    let opened = false;
    let stream = null;
    let controller = null;
    // Bytes that arrive while no stream is read; the next stream starts with them.
    let backlog = [];
    const emit = bytes => {
      if (!opened) {
        return;
      }
      if (controller) {
        controller.enqueue(new Uint8Array(bytes));
      } else {
        backlog.push(...bytes);
      }
    };
    const requireOpen = () => {
      if (!opened) {
        throw new DOMException('The port is closed.', 'InvalidStateError');
      }
    };
    const device = {
      connected: true,
      writable: null,
      // As in Chrome: a stream that was cancelled is replaced while the port is open.
      get readable() {
        if (opened && !stream) {
          stream = new ReadableStream({
            start(started) {
              controller = started;
              if (backlog.length > 0) {
                started.enqueue(new Uint8Array(backlog));
                backlog = [];
              }
            },
            cancel() {
              controller = null;
              stream = null;
            }
          });
        }
        return stream;
      },
      getInfo: () => serialInfo(port),
      async open(options) {
        record(port.id, 'open', [options]);
        if (opened) {
          throw new DOMException(
            'The port is already open.',
            'InvalidStateError'
          );
        }
        if (port.openError) {
          throw fail(port.openError);
        }
        opened = true;
        device.writable = new WritableStream({
          write(chunk) {
            const bytes = Array.from(chunk);
            record(port.id, 'write', [bytes]);
            if (port.echo !== false) {
              emit(bytes);
            }
          }
        });
      },
      async setSignals(signals) {
        requireOpen();
        record(port.id, 'setSignals', [signals]);
      },
      async close() {
        requireOpen();
        // As in Chrome: close() fails while a stream of the port is locked.
        if ((stream && stream.locked) || device.writable.locked) {
          throw new TypeError('Cannot cancel a locked stream');
        }
        opened = false;
        stream = null;
        controller = null;
        backlog = [];
        device.writable = null;
        record(port.id, 'close', []);
      },
      async forget() {
        record(port.id, 'forget', []);
        forgetGrant(ports, port.id);
      }
    };
    return { device, emit };
  };

  const makeUsb = usb => {
    const word = value => [value & 0xff, value >> 8];
    const strings = [
      null,
      usb.manufacturerName,
      usb.productName,
      usb.serialNumber
    ];
    const deviceDescriptor = [
      ...[18, 1, ...word(0x0200), 0, 0, 0, 64],
      ...[...word(usb.vendorId), ...word(usb.productId), ...word(0x0100)],
      ...[1, 2, 3, 1]
    ];
    const configurationDescriptor = [
      ...[9, 2, 32, 0, 1, 1, 0, 0x80, 50],
      ...[9, 4, 0, 0, 2, 0xff, 0, 0, 0],
      ...[7, 5, 0x01, 2, 64, 0, 0],
      ...[7, 5, 0x81, 2, 64, 0, 0]
    ];
    const stringDescriptor = index => {
      if (index === 0) {
        return [4, 3, 0x09, 0x04];
      }
      const units = Array.from(strings[index] || '').flatMap(character =>
        word(character.charCodeAt(0))
      );
      return [units.length + 2, 3, ...units];
    };
    const alternate = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      interfaceName: null,
      endpoints: [
        { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
        { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 }
      ]
    };
    const iface = {
      interfaceNumber: 0,
      claimed: false,
      alternate,
      alternates: [alternate]
    };
    const configuration = {
      configurationValue: 1,
      configurationName: null,
      interfaces: [iface]
    };
    let loopback = [];
    // The transfer in that waits for bytes: { length, resolve, reject }.
    let waiting = null;
    const inResult = bytes => ({
      status: 'ok',
      data: new DataView(new Uint8Array(bytes).buffer)
    });
    /** Record one call, then refuse it as the test or the state of the device says. */
    const call = (op, args, needs) => {
      record(usb.id, op, args);
      const refusal = (usb.fail || {})[op];
      if (refusal) {
        throw fail(refusal);
      }
      if (needs !== 'nothing' && !device.opened) {
        throw new DOMException(
          'The device must be opened first.',
          'InvalidStateError'
        );
      }
      if (needs === 'claimed' && !iface.claimed) {
        throw new DOMException(
          'The specified endpoint is not part of a claimed and selected alternate interface.',
          'NotFoundError'
        );
      }
    };
    const setupOf = ({ requestType, recipient, request, value, index }) => ({
      requestType,
      recipient,
      request,
      value,
      index
    });
    const device = {
      usbVersionMajor: 2,
      usbVersionMinor: 0,
      usbVersionSubminor: 0,
      deviceClass: 0,
      deviceSubclass: 0,
      deviceProtocol: 0,
      vendorId: usb.vendorId,
      productId: usb.productId,
      deviceVersionMajor: 1,
      deviceVersionMinor: 0,
      deviceVersionSubminor: 0,
      manufacturerName: usb.manufacturerName || null,
      productName: usb.productName || null,
      serialNumber: usb.serialNumber || null,
      configuration,
      configurations: [configuration],
      opened: false,
      async open() {
        call('open', [], 'nothing');
        device.opened = true;
      },
      async close() {
        call('close', [], 'nothing');
        device.opened = false;
        iface.claimed = false;
        if (waiting) {
          waiting.reject(
            new DOMException('The transfer was cancelled.', 'AbortError')
          );
          waiting = null;
        }
      },
      async forget() {
        call('forget', [], 'nothing');
        forgetGrant(devices, usb.id);
      },
      async reset() {
        call('reset', [], 'open');
      },
      async selectConfiguration(configurationValue) {
        call('selectConfiguration', [configurationValue], 'open');
      },
      async claimInterface(interfaceNumber) {
        call('claimInterface', [interfaceNumber], 'open');
        iface.claimed = true;
      },
      async releaseInterface(interfaceNumber) {
        call('releaseInterface', [interfaceNumber], 'claimed');
        iface.claimed = false;
      },
      async selectAlternateInterface(interfaceNumber, alternateSetting) {
        const args = [interfaceNumber, alternateSetting];
        call('selectAlternateInterface', args, 'claimed');
      },
      async clearHalt(direction, endpointNumber) {
        call('clearHalt', [direction, endpointNumber], 'claimed');
      },
      async controlTransferIn(setup, length) {
        call('controlTransferIn', [setupOf(setup), length], 'open');
        if (
          setup.requestType !== 'standard' ||
          setup.request !== GET_DESCRIPTOR
        ) {
          return { status: 'stall' };
        }
        const kind = setup.value >> 8;
        const descriptor =
          kind === 1
            ? deviceDescriptor
            : kind === 2
              ? configurationDescriptor
              : stringDescriptor(setup.value & 0xff);
        return inResult(descriptor.slice(0, length));
      },
      async controlTransferOut(setup, data) {
        const bytes = bytesOf(data);
        call('controlTransferOut', [setupOf(setup), bytes], 'open');
        return { status: 'ok', bytesWritten: bytes.length };
      },
      async transferOut(endpointNumber, data) {
        const bytes = bytesOf(data);
        call('transferOut', [endpointNumber, bytes], 'claimed');
        loopback.push(...bytes);
        if (waiting) {
          const { length, resolve } = waiting;
          waiting = null;
          resolve(inResult(loopback.splice(0, length)));
        }
        return { status: 'ok', bytesWritten: bytes.length };
      },
      async transferIn(endpointNumber, length) {
        call('transferIn', [endpointNumber, length], 'claimed');
        if (loopback.length > 0) {
          return inResult(loopback.splice(0, length));
        }
        return new Promise((resolve, reject) => {
          waiting = { length, resolve, reject };
        });
      }
    };
    return { device };
  };

  /** The granted devices of one kind; a device keeps its object while it has its grant. */
  const listed = async (definitions, made, make) => {
    const ids = await granted();
    return (definitions || [])
      .filter(
        definition =>
          ids.includes(definition.id) && !unplugged.has(definition.id)
      )
      .map(definition => {
        if (!made.has(definition.id)) {
          made.set(definition.id, make(definition));
        }
        return made.get(definition.id).device;
      });
  };

  channel.onmessage = event => {
    const message = event.data;
    if (message.type === 'grants' && message.worker === worker) {
      const resolve = answers.get(message.query);
      if (resolve) {
        answers.delete(message.query);
        resolve(message.ids);
      }
    } else if (message.type === 'send' && ports.has(message.id)) {
      ports.get(message.id).emit(message.bytes);
    } else if (message.type === 'stream' && ports.has(message.id)) {
      let sent = 0;
      const next = () => {
        ports.get(message.id).emit(message.bytes);
        sent += 1;
        if (sent === message.count) {
          clearInterval(timer);
        }
      };
      const timer = setInterval(next, message.interval);
      next();
    } else if (message.type === 'unplug') {
      // The device leaves the listing first, then the event fires, as in Chrome.
      unplugged.add(message.id);
      const source = ports.has(message.id) ? serial : usb;
      source.dispatchEvent(new Event('disconnect'));
    } else if (message.type === 'allow-open' && ports.has(message.id)) {
      // The port reads `openError` from its definition at every `open()`.
      delete config.serial.find(port => port.id === message.id).openError;
      record(message.id, 'allowOpen', []);
    }
  };

  const serial = new EventTarget();
  serial.getPorts = () => listed(config.serial, ports, makePort);
  define('serial', serial);
  const usb = new EventTarget();
  usb.getDevices = () => listed(config.usb, devices, makeUsb);
  define('usb', usb);
}

// A spec reads the text of this file; `module` does not exist in the browser.
if (typeof module !== 'undefined') {
  module.exports = installDeviceSim;
}
