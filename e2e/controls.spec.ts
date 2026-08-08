import { expect, test } from '@playwright/test';
import {
  clearUpstreamLog,
  meta,
  upstreamLog,
  url,
  watchPageErrors,
} from './helpers.ts';

// Every control changes the screen by writing to the URL. These check that
// the write happens and that a fetch follows it, which is the part a unit
// test stubs out.

watchPageErrors();
test.beforeEach(async ({ page }) => {
  await clearUpstreamLog(page);
});

test('Run puts the edited query in the URL and refetches', async ({ page }) => {
  await page.goto(url('/'));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const edited = `{service_name="${meta.service}", profile_type="${meta.profileType}", region="eu-west"}`;
  const input = page.getByRole('combobox');
  await input.fill(edited);

  // Typing alone must not navigate — the buffer is local until Run.
  expect(new URL(page.url()).searchParams.get('query')).toBe(meta.query);

  await clearUpstreamLog(page);
  // Exact: the top table's symbol buttons are named runtime.*.
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(page).toHaveURL(/region%3D%22eu-west%22/);
  await expect
    .poll(async () =>
      (await upstreamLog(page)).some(
        (entry) => entry.method === 'SelectMergeStacktraces',
      ),
    )
    .toBe(true);
});

test('a time-range preset writes a relative from and drops until', async ({
  page,
}) => {
  await page.goto(url('/'));
  await page
    .getByRole('button', { name: /\d{4}-|Last|:/ })
    .first()
    .click();
  await page.getByText('Last 30 minutes').click();

  const params = new URL(page.url()).searchParams;
  expect(params.get('from')).toBe('now-30m');
  expect(params.has('until')).toBe(false);
});

test('the range picker applies an absolute window as unix milliseconds', async ({
  page,
}) => {
  await page.goto(url('/'));
  await page
    .getByRole('button', { name: /\d{4}-|Last|:/ })
    .first()
    .click();

  const from = page
    .locator('.trp-field')
    .filter({ hasText: 'From' })
    .getByRole('textbox');
  const to = page
    .locator('.trp-field')
    .filter({ hasText: 'To' })
    .getByRole('textbox');
  await from.fill('2026-01-02 09:05:00');
  await to.fill('2026-01-02 17:30:00');
  await page.getByRole('button', { name: 'Apply time range' }).click();

  const params = new URL(page.url()).searchParams;
  expect(Number(params.get('from'))).toBe(
    new Date(2026, 0, 2, 9, 5, 0).getTime(),
  );
  expect(Number(params.get('until'))).toBe(
    new Date(2026, 0, 2, 17, 30, 0).getTime(),
  );
});

test('the tag explorer switches the label it groups by', async ({ page }) => {
  await page.goto(url('/explore', { groupBy: 'region' }));
  await expect(page.locator('.tag-explorer-table')).toBeVisible();

  // service_name and profile_type are left out on purpose: the query already
  // pins both, so grouping by them would say nothing.
  const offered = await page.locator('.tag-explorer-label').allInnerTexts();
  expect(offered).not.toContain('service_name');
  expect(offered).toContain('region');

  await clearUpstreamLog(page);
  await page
    .locator('.tag-explorer-label', { hasText: 'pyroscope_spy' })
    .click();

  await expect(page).toHaveURL(/groupBy=pyroscope_spy/);
  await expect
    .poll(async () =>
      (await upstreamLog(page)).some((entry) =>
        entry.groupBy?.includes('pyroscope_spy'),
      ),
    )
    .toBe(true);
});

test('the query bar suggests labels from the server', async ({ page }) => {
  await page.goto(url('/'));
  const input = page.getByRole('combobox');
  await input.click();
  await input.fill('{');

  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  // LabelNames, minus the dunder ones the UI hides. `__profile_type__` is
  // the exception: it is offered, under the display name the query language
  // uses. Asserting on the raw name instead would be unfalsifiable, since it
  // is rewritten before it is ever rendered.
  await expect(listbox.getByRole('option', { name: 'region' })).toBeVisible();
  await expect(
    listbox.getByRole('option', { name: 'profile_type', exact: true }),
  ).toBeVisible();
  for (const internal of ['__name__', '__unit__', '__service_name__']) {
    await expect(listbox.getByText(internal)).toHaveCount(0);
  }

  await listbox.getByRole('option', { name: 'region' }).click();
  await expect(input).toHaveValue('{region=""');
});
