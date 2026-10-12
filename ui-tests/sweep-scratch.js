/**
 * Remove what a run of the suite leaves behind: the private Jupyter runtime directory
 * (the record of the test server) and the device directory of the test server (links
 * to virtual serial devices and shim sockets of a server that was killed).
 *
 * It runs before the test server starts, chained into `webServer.command` of
 * playwright.config.js, and again as `globalTeardown`. It is no `globalSetup`:
 * Playwright starts the web server before globalSetup, so it would remove the record
 * of the server that just started, and `jupyter server list` would then be empty.
 */
const fs = require('fs');
const path = require('path');

const PORT = process.env.JUPYTER_TEST_PORT || '8888';

const sweep = async () => {
  for (const directory of [
    path.join(__dirname, '.tmp-runtime'),
    // The same path as in jupyter_server_test_config.py.
    `/tmp/jupyterlab-device-galata-${PORT}`
  ]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

module.exports = sweep;

// As a script it sweeps; required as globalTeardown it only exports the function.
if (require.main === module) {
  sweep();
}
