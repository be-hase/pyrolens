import { expect, test } from '@playwright/test';
import { failOnPageErrors, url } from './helpers.ts';

// What the binary serves, and how the SPA behaves on top of it. main_test.go
// checks the same routes at the Go level; this checks the browser agrees.

test.beforeEach(({ page }) => failOnPageErrors(page));

test('every view deep-links straight from the address bar', async ({
  page,
}) => {
  for (const [path, heading] of [
    ['/', 'Flamegraph'],
    ['/comparison', 'Comparison'],
    ['/diff', 'Diff'],
    ['/explore', 'Group by'],
  ] as const) {
    const response = await page.goto(url(path));
    expect(response?.status(), path).toBe(200);
    await expect(page.getByText(heading).first(), path).toBeVisible();
  }
});

test('an unknown path still gets the app, not a 404', async ({ page }) => {
  const response = await page.goto(url('/deep/unknown/route'));
  expect(response?.status()).toBe(200);
  // The fallback hands over the shell; the router lands on the single view.
  await expect(page.getByText('Flamegraph').first()).toBeVisible();
});

test('the tabs switch views without reloading the page', async ({ page }) => {
  await page.goto(url('/'));
  await expect(page.getByText('Flamegraph').first()).toBeVisible();

  // Survives a client-side navigation, not a document load.
  await page.evaluate(() => {
    (window as unknown as { __alive: boolean }).__alive = true;
  });

  await page.getByRole('link', { name: 'Tag Explorer' }).click();
  await expect(page).toHaveURL(/\/explore/);
  await expect(page.getByText('Group by').first()).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __alive?: boolean }).__alive,
    ),
  ).toBe(true);
});

test('switching views keeps the query and the range', async ({ page }) => {
  await page.goto(url('/'));
  const before = new URL(page.url()).searchParams;

  await page.getByRole('link', { name: 'Diff' }).click();
  await expect(page).toHaveURL(/\/diff/);
  const after = new URL(page.url()).searchParams;
  for (const key of ['query', 'from', 'until', 'tenant']) {
    expect(after.get(key), key).toBe(before.get(key));
  }
});

test('the back button returns to the previous view', async ({ page }) => {
  await page.goto(url('/'));
  await page.getByRole('link', { name: 'Comparison' }).click();
  await expect(page).toHaveURL(/\/comparison/);

  await page.goBack();
  await expect(page).toHaveURL(/^[^?]*\/\?/);
  await expect(page.getByText('Flamegraph').first()).toBeVisible();
});

test('hashed assets are served immutable, and a missing one 404s', async ({
  page,
}) => {
  await page.goto(url('/'));
  const asset = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map(
      (el) => (el as HTMLScriptElement).src,
    ),
  );
  const bundle = asset.find((src) => src.includes('/assets/'));
  expect(bundle, 'the page should load a hashed bundle').toBeTruthy();

  const ok = await page.request.get(bundle!);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['cache-control']).toContain('immutable');

  // A stale index would otherwise hand the browser HTML with a script's
  // content type.
  const missing = await page.request.get('/assets/index-gone.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type'] ?? '').not.toContain('text/html');
});

test('healthz answers without touching Pyroscope', async ({ page }) => {
  const res = await page.request.get('/healthz');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('ok');
});
