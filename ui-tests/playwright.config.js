/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const path = require('path');
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

// Galata pins the test server to 8888 and does not move it when the port is taken.
// JUPYTER_TEST_PORT moves the server (jupyter_server_test_config.py) and this base URL together.
const PORT = process.env.JUPYTER_TEST_PORT || '8888';
const BASE_URL = `http://localhost:${PORT}`;

// The suite starts the real `jupyterlab-device` command, from the specs and inside a lab
// terminal of the test server. That command finds its server with `jupyter server list`,
// which reads the runtime directory, and it sends the hub token first. So the test
// server and every child process get a runtime directory that lists the test server
// alone, and no hub variable and no token of another server. Without this the command
// reaches the lab that a developer runs on this machine.
//
// When the list is empty the command falls back on JUPYTER_PORT. That variable names a
// port where nothing listens, so a command whose search failed ends with "cannot reach"
// and its test fails. With the port of the test server here, such a command would work
// and the suite would pass without the search it has to prove. The test server takes
// its own port from its configuration file, not from this variable.
//
// Environment set here reaches the web server and every worker; nothing here deletes a
// file, because every worker runs this module.
for (const name of Object.keys(process.env)) {
  if (
    name.startsWith('JUPYTERHUB_') ||
    name.startsWith('JPY_') ||
    name === 'JUPYTER_TOKEN'
  ) {
    delete process.env[name];
  }
}
process.env.JUPYTER_RUNTIME_DIR = path.join(__dirname, '.tmp-runtime');
process.env.JUPYTER_PORT = '1';

module.exports = {
  ...baseConfig,
  // Every spec uses the one test server and its device table.
  workers: 1,
  fullyParallel: false,
  use: { ...baseConfig.use, baseURL: BASE_URL },
  globalTeardown: require.resolve('./sweep-scratch.js'),
  webServer: {
    // The sweep runs here and not in a globalSetup: Playwright starts the web server
    // before globalSetup, so a sweep there would remove the record of the live server.
    command: 'node sweep-scratch.js && jlpm start',
    url: `${BASE_URL}/lab`,
    timeout: 120 * 1000,
    // Never adopt a server this suite did not start: on 8888 that is a developer's own lab.
    reuseExistingServer: false
  }
};
