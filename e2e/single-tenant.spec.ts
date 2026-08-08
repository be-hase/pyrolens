import { expect, test } from '@playwright/test';
import { failOnPageErrors, meta } from './helpers.ts';

// Against a Pyroscope started without -auth.multitenancy-enabled, which the
// dev stack also offers (`--profile single`). The probe is answered rather
// than refused, and the UI should carry no tenant anything at all.
//
// This project runs against its own server pair; see playwright.config.ts.

const url = (path: string) => {
  const params = new URLSearchParams({
    query: meta.query,
    from: String(meta.window.start),
    until: String(meta.window.end),
  });
  return `${path}?${params}`;
};

test.beforeEach(({ page }) => failOnPageErrors(page));

test('no tenant is asked for, and the view renders', async ({ page }) => {
  await page.goto(url('/'));

  await expect(
    page.getByRole('dialog', { name: 'Enter a Tenant ID' }),
  ).toBeHidden();
  await expect(
    page.getByRole('cell', { name: 'main.queryDatabase' }),
  ).toBeVisible();
});

test('the nav bar offers no tenant to change', async ({ page }) => {
  await page.goto(url('/'));
  await expect(page.getByText('Flamegraph').first()).toBeVisible();
  await expect(page.getByTitle('Change tenant')).toHaveCount(0);
});

test('requests go out without a tenant header', async ({ page }) => {
  await page.request.delete('http://127.0.0.1:4144/__log');
  await page.goto(url('/'));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const log = await (
    await page.request.get('http://127.0.0.1:4144/__log')
  ).json();
  const queries = log.filter(
    (entry: { method: string }) => entry.method !== 'LabelNames',
  );
  expect(queries.length).toBeGreaterThan(0);
  // Undefined, not empty: an empty X-Scope-OrgID is the probe, and sending it
  // on a real query would be refused by a server that does want a tenant.
  expect(
    queries.every((e: { tenant: string | null }) => e.tenant === null),
  ).toBe(true);
});

test('a tenant pasted into the URL still rides along, and is harmless', async ({
  page,
}) => {
  // Someone pastes a link from a multitenant deployment. The header follows
  // the URL param unconditionally — it is synced at module load, before the
  // probe can know what kind of server this is — and a server started without
  // multitenancy ignores it. What must not happen is tenant UI appearing.
  await page.request.delete('http://127.0.0.1:4144/__log');
  await page.goto(`${url('/')}&tenant=team-a`);
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  await expect(page.getByTitle('Change tenant')).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Enter a Tenant ID' }),
  ).toBeHidden();

  const log = await (
    await page.request.get('http://127.0.0.1:4144/__log')
  ).json();
  const queries = log.filter(
    (entry: { method: string }) => entry.method !== 'LabelNames',
  );
  expect(queries.length).toBeGreaterThan(0);
  expect(
    queries.every((e: { tenant: string | null }) => e.tenant === 'team-a'),
  ).toBe(true);
});
