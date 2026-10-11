/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

// Galata pins the test server to 8888 and does not move it when the port is taken.
// JUPYTER_TEST_PORT moves the server (jupyter_server_test_config.py) and this base URL together.
const PORT = process.env.JUPYTER_TEST_PORT || '8888';
const BASE_URL = `http://localhost:${PORT}`;

module.exports = {
  ...baseConfig,
  use: { ...baseConfig.use, baseURL: BASE_URL },
  webServer: {
    command: 'jlpm start',
    url: `${BASE_URL}/lab`,
    timeout: 120 * 1000,
    // Never adopt a server this suite did not start: on 8888 that is a developer's own lab.
    reuseExistingServer: false
  }
};
