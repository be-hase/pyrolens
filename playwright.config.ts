import { defineConfig, devices } from '@playwright/test';

// End-to-end against the real binary: `yarn test:e2e` builds the UI, links it
// into the server and starts that, pointed at a fake Pyroscope replaying
// captured fixtures (e2e/capture.mjs). Everything the unit tests cannot reach
// is in that chain — the embedded assets, the SPA fallback, the proxy, the
// wire decoding and the canvas.
//
// Playwright's browsers are not downloaded by `yarn install` (.yarnrc.yml
// disables install scripts); run `yarn playwright install chromium` once.

const UI_PORT = 4141;
const UPSTREAM_PORT = 4142;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  // The fake upstream keeps a request log the suite reads back, so the specs
  // share state on purpose and run one at a time.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // Wide enough that the flame graph keeps its top table; below about
      // 1000px it drops to the graph alone and the frame names disappear.
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1500, height: 950 },
      },
    },
  ],
  webServer: [
    {
      command: `node e2e/fake-pyroscope.mjs`,
      env: { PORT: String(UPSTREAM_PORT) },
      url: `http://127.0.0.1:${UPSTREAM_PORT}/__log`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
    },
    {
      command: `./pyrolens -listen 127.0.0.1:${UI_PORT} -pyroscope-url http://127.0.0.1:${UPSTREAM_PORT}`,
      url: `http://127.0.0.1:${UI_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
    },
  ],
});
