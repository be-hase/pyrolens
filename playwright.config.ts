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
// Exported so helpers.ts's upstreamLog()/clearUpstreamLog() hit the same
// port this file wires the fake up on, instead of a second hardcoded 4142
// that could silently drift from it.
export const UPSTREAM_PORT = 4142;
// A second pair, wired to a fake that does not ask for a tenant, so the flow
// where no tenant UI appears at all is exercised too.
const SINGLE_UI_PORT = 4143;
const SINGLE_UPSTREAM_PORT = 4144;

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
    // Deliberately not the runner's locale. The UI is English throughout and
    // formats dates and numbers with its own helpers; a `toLocale*` creeping
    // back in is invisible on an en-US runner and ships Japanese month names
    // to anyone else, which is a regression this project has had before.
    // (The timezone is left alone: the specs compare timestamps they compute
    // in Node against ones the browser parsed, so the two must agree.)
    locale: 'ja-JP',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'single-tenant',
      testMatch: /single-tenant\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1500, height: 950 },
        baseURL: `http://127.0.0.1:${SINGLE_UI_PORT}`,
      },
    },
    {
      name: 'chromium',
      testIgnore: /single-tenant\.spec\.ts/,
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
      // Never reuse a leaked ./pyrolens: it embeds the UI at build time
      // (AGENTS.md), so a stale process from an earlier run would serve last
      // build's assets while this run believes it is testing the current
      // one — a leftover green run proving nothing.
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `node e2e/fake-pyroscope.mjs`,
      env: { PORT: String(SINGLE_UPSTREAM_PORT), MULTITENANT: '0' },
      url: `http://127.0.0.1:${SINGLE_UPSTREAM_PORT}/__log`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
    },
    {
      command: `./pyrolens -listen 127.0.0.1:${SINGLE_UI_PORT} -pyroscope-url http://127.0.0.1:${SINGLE_UPSTREAM_PORT}`,
      url: `http://127.0.0.1:${SINGLE_UI_PORT}/healthz`,
      // Same reasoning as the other ./pyrolens entry above.
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
});
