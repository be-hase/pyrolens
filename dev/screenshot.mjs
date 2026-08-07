// Screenshots every view in both themes, so a visual change can be reviewed
// as a picture instead of a claim. Needs a Pyrolens serving data — see
// dev/README.md.
//
// Playwright is deliberately not a dependency of this project: install it
// into a scratch directory and point PLAYWRIGHT at it (dev/README.md has the
// exact commands). Writes dev/screenshots/<view>-<theme>.png.

import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const BASE = process.env.BASE ?? 'http://localhost:4041';
const TENANT = process.env.TENANT ?? '';
const OUT = process.env.OUT ?? 'dev/screenshots';

const tenant = TENANT ? `tenant=${encodeURIComponent(TENANT)}&` : '';
const now = Date.now();

const views = [
  { name: 'single', path: `/?${tenant}`, ready: 'canvas' },
  { name: 'comparison', path: `/comparison?${tenant}`, ready: 'canvas' },
  {
    name: 'diff',
    // Two adjacent windows, so the diff has something to show.
    path:
      `/diff?${tenant}leftFrom=${now - 240000}&leftUntil=${now - 120000}` +
      `&rightFrom=${now - 120000}&rightUntil=${now}`,
    ready: 'canvas',
  },
  {
    name: 'explore',
    path: `/explore?${tenant}groupBy=region`,
    ready: '.tag-explorer-table',
  },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const theme of ['dark', 'light']) {
  for (const view of views) {
    const context = await browser.newContext({
      viewport: { width: 1500, height: 950 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    try {
      await page.addInitScript(
        (t) => localStorage.setItem('pyrolens:theme', t),
        theme,
      );
      await page.goto(BASE + view.path, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(view.ready, { timeout: 30000 });
      // Let the charts finish their first paint.
      await page.waitForTimeout(2500);
      const file = `${OUT}/${view.name}-${theme}.png`;
      await page.screenshot({ path: file });
      console.log(
        `${file}${errors.length ? `  PAGE ERROR: ${errors[0]}` : ''}`,
      );
      if (errors.length) failures++;
    } catch (e) {
      console.error(`${view.name}-${theme}: FAILED ${String(e).slice(0, 160)}`);
      failures++;
    }
    await context.close();
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
