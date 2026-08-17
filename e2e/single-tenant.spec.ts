import { expect, test } from '@playwright/test';
import { meta, watchPageErrors } from './helpers.ts';

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

watchPageErrors();

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

test('a tenant pasted into the URL is stripped once single-tenant is confirmed', async ({
  page,
}) => {
  // Someone pastes a link from a multitenant deployment. The header follows
  // the URL param unconditionally at first — it is synced at module load,
  // before the probe can know what kind of server this is — but once the
  // probe confirms single-tenant, that stale tenant must be dropped: a
  // server started with an allowlist would otherwise 403 every fetch, and
  // single-tenant mode offers no tenant UI to recover through.
  await page.request.delete('http://127.0.0.1:4144/__log');
  await page.goto(`${url('/')}&tenant=team-a`);
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  await expect(page.getByTitle('Change tenant')).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Enter a Tenant ID' }),
  ).toBeHidden();
  await expect(page).toHaveURL(
    (current) => !current.searchParams.has('tenant'),
  );

  // What the strip must guarantee is that a TENANTLESS refetch was issued —
  // that is what recovers an allowlist deployment. The team-a request that
  // was already on the wire is aborted client-side and its response
  // discarded, but its bytes still reach the fake, and arrival order is not
  // deterministic: it can be logged either side of the strip's own refetch.
  // So neither "every query" nor "the last query" is assertable (the latter
  // flaked ~1 in 20 locally); poll for the tenantless query's existence,
  // which only the strip's refetch can produce.
  await expect
    .poll(async () => {
      const log = await (
        await page.request.get('http://127.0.0.1:4144/__log')
      ).json();
      return log.some(
        (entry: { method: string; tenant: string | null }) =>
          entry.method !== 'LabelNames' && entry.tenant === null,
      );
    })
    .toBe(true);
});
