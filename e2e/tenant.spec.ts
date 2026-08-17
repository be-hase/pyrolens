import { expect, test } from '@playwright/test';
import {
  clearUpstreamLog,
  meta,
  upstreamLog,
  watchPageErrors,
} from './helpers.ts';

// The fake upstream refuses an empty X-Scope-OrgID, exactly as a multitenant
// Pyroscope does, so the whole tenancy flow runs for real here.

watchPageErrors();
// No context.clearCookies() here: tenant persistence is localStorage
// (App.tsx's TENANT_KEY), not a cookie, so clearing cookies never touched
// the thing this suite needs isolated between tests — and didn't need to.
// Playwright gives every test its own fresh browser context by default, so
// localStorage already starts empty each time.
test.beforeEach(async ({ page }) => {
  await clearUpstreamLog(page);
});

test('a multitenant server is asked for a tenant before anything is queried', async ({
  page,
}) => {
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Enter a Tenant ID' });
  await expect(dialog).toBeVisible();

  // Only the probe may have gone out, and it must have carried the empty
  // tenant that asks the question.
  // Waited for, not sampled: a query fired under the wrong tenant may not
  // have reached the fake yet. The count guard matters because every() is
  // vacuously true on an empty log — without it this passes when the probe
  // was never sent at all.
  await expect
    .poll(async () => (await upstreamLog(page)).length)
    .toBeGreaterThan(0);
  const log = await upstreamLog(page);
  expect(log.every((entry) => entry.tenant === '')).toBe(true);
  expect(log.some((entry) => entry.method === 'SelectMergeStacktraces')).toBe(
    false,
  );
});

test('the chosen tenant reaches the upstream through the proxy', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Enter a Tenant ID' });
  await expect(dialog).toBeVisible();

  await clearUpstreamLog(page);
  await dialog.getByRole('textbox').fill(meta.tenant);
  await dialog.getByRole('button', { name: 'Submit' }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`tenant=${meta.tenant}`));

  await expect
    .poll(async () => {
      const log = await upstreamLog(page);
      return log.some(
        (entry) => entry.method === 'Series' && entry.tenant === meta.tenant,
      );
    })
    .toBe(true);
});

test('the tenant is remembered for the next visit', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Enter a Tenant ID' });
  await dialog.getByRole('textbox').fill(meta.tenant);
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog).toBeHidden();

  // Come back without a tenant in the URL: it is restored and written back,
  // so the address stays shareable.
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`tenant=${meta.tenant}`));
  await expect(
    page.getByRole('dialog', { name: 'Enter a Tenant ID' }),
  ).toBeHidden();
});

test('switching tenants re-queries under the new one', async ({ page }) => {
  // The old tenant's view/query/from/until describe that tenant's world, so
  // a real switch must reset the URL down to the root view with just the
  // new tenant, not carry them over onto a tenant they don't describe.
  const params = new URLSearchParams({
    tenant: meta.tenant,
    query: meta.query,
    from: String(meta.window.start),
    until: String(meta.window.end),
  });
  await page.goto(`/explore?${params}`);
  await expect(page.getByRole('button', { name: meta.tenant })).toBeVisible();

  // Captured via the navigation events themselves, not sampled from
  // `page.url()` after the fact: the tenant-only URL the reset produces is
  // transient — once team-b's own services fetch settles (the default-query
  // effect deliberately waits for it rather than firing from team-a's stale
  // list; see App.tsx), a fresh query is replace-written back in. Against
  // the local fake that round-trip is fast enough that sampling afterwards
  // races it; listening for each navigation as it lands does not.
  const navigatedUrls: URL[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigatedUrls.push(new URL(frame.url()));
    }
  });

  await page.getByRole('button', { name: meta.tenant }).click();
  const dialog = page.getByRole('dialog', { name: 'Enter a Tenant ID' });
  await dialog.getByRole('textbox').fill('team-b');
  await dialog.getByRole('button', { name: 'Submit' }).click();

  await expect(page).toHaveURL(/tenant=team-b/);
  await expect
    .poll(() =>
      navigatedUrls.some((url) => {
        const p = url.searchParams;
        return (
          url.pathname === '/' &&
          [...p.keys()].length === 1 &&
          p.get('tenant') === 'team-b'
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await upstreamLog(page)).some((entry) => entry.tenant === 'team-b'),
    )
    .toBe(true);

  // Once the switch has happened nothing may go out under the old tenant.
  // Slicing the log at its first team-b entry doesn't prove that: a team-a
  // request already in flight at the moment of the switch can still reach
  // the fake and get logged *after* that first team-b entry, purely from
  // network scheduling — that arrival order isn't evidence of a bug. Give
  // in-flight work time to land, then clear the log and check only what
  // arrives from this point on, which is unambiguous either way.
  await page.waitForTimeout(1_000);
  await clearUpstreamLog(page);
  await page.waitForTimeout(500);
  const log = await upstreamLog(page);
  expect(log.every((entry) => entry.tenant === 'team-b')).toBe(true);
});
