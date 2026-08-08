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
test.beforeEach(async ({ page, context }) => {
  await context.clearCookies();
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
  await page.goto(`/?tenant=${meta.tenant}`);
  await expect(page.getByRole('button', { name: meta.tenant })).toBeVisible();

  await page.getByRole('button', { name: meta.tenant }).click();
  const dialog = page.getByRole('dialog', { name: 'Enter a Tenant ID' });
  await dialog.getByRole('textbox').fill('team-b');
  await dialog.getByRole('button', { name: 'Submit' }).click();

  await expect(page).toHaveURL(/tenant=team-b/);
  await expect
    .poll(async () =>
      (await upstreamLog(page)).some((entry) => entry.tenant === 'team-b'),
    )
    .toBe(true);

  // Once the switch has happened nothing may go out under the old tenant.
  // Requests already in flight when it happened are why this is asked as an
  // ordering question rather than "the log holds only team-b".
  const log = await upstreamLog(page);
  const switched = log.findIndex((entry) => entry.tenant === 'team-b');
  expect(log.slice(switched).every((entry) => entry.tenant === 'team-b')).toBe(
    true,
  );
});
