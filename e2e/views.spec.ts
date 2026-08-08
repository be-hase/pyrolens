import { expect, test } from '@playwright/test';
import {
  clearUpstreamLog,
  expectCanvasPainted,
  meta,
  upstreamLog,
  url,
  watchPageErrors,
} from './helpers.ts';

// The four views, rendered by the real binary from the real wire format.
// Everything here is out of reach of the unit tests: the embedded assets, the
// proxy, and the decode that ends in a canvas.

// The fake upstream's request log is shared, so every spec starts from an
// empty one.
watchPageErrors();
test.beforeEach(async ({ page }) => {
  await clearUpstreamLog(page);
});

test('the single view renders a flame graph and a timeline', async ({
  page,
}) => {
  await page.goto(url('/'));

  // The top table lists what the flamebearer decoded, so a frame appearing
  // by name means the whole chain produced real frames.
  await expect(
    page.getByRole('cell', { name: 'main.queryDatabase' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'main.cpuWork' })).toBeVisible();

  // "<total> | <n> samples (Time)" — the unit comes from the profile type.
  await expect(page.locator('.plfg-metadata-pill').first()).toContainText(
    /samples \(Time\)/,
  );

  await expectCanvasPainted(page.locator('.plfg-canvas-graph canvas').first());
  await expectCanvasPainted(page.locator('.timeseries-canvas').first());

  await expect(page.locator('.timeseries-x-label').first()).toBeVisible();
});

test('axis dates stay fixed English whatever the browser locale is', async ({
  page,
}) => {
  // The browser runs as ja-JP (playwright.config.ts). A day-wide range puts
  // the axis on its date branch, which must come from the project's own
  // helpers — a `toLocale*` here would render 1月2日 and has shipped once.
  const day = 86_400_000;
  await page.goto(
    url('/', {
      from: meta.window.end - 5 * day,
      until: meta.window.end,
    }),
  );
  await expect(page.locator('.timeseries-x-label').first()).toBeVisible();

  const labels = await page.locator('.timeseries-x-label').allInnerTexts();
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  }
});

test('the single view asks for exactly the profile the URL names', async ({
  page,
}) => {
  await page.goto(url('/'));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const log = await upstreamLog(page);
  const stacktraces = log.filter(
    (entry) => entry.method === 'SelectMergeStacktraces',
  );
  expect(stacktraces.length).toBeGreaterThan(0);
  expect(stacktraces.every((entry) => entry.tenant === meta.tenant)).toBe(true);
  // The profile itself, not just that something was asked for: the fake
  // replays the same fixture whatever it is sent, so a query that lost its
  // profile_type or sent seconds for milliseconds still renders correctly.
  for (const entry of stacktraces) {
    expect(entry.profileTypeID).toBe(meta.profileType);
    expect(entry.labelSelector).toBe(`{service_name="${meta.service}"}`);
    expect(entry.start).toBe(meta.window.start);
    expect(entry.end).toBe(meta.window.end);
  }
});

test('the comparison view renders both panes', async ({ page }) => {
  await page.goto(
    url('/comparison', {
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );

  const flamegraphs = page.locator('.plfg-canvas-graph canvas');
  await expect(flamegraphs).toHaveCount(2);
  await expect(page.locator('.timeseries-canvas')).toHaveCount(2);
  await expectCanvasPainted(flamegraphs.nth(0));
  await expectCanvasPainted(flamegraphs.nth(1));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();
});

test('the diff view renders the frame that differs between the windows', async ({
  page,
}) => {
  await page.goto(
    url('/diff', {
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );

  // The load generator adds this frame every other minute, so it is what the
  // two adjacent windows disagree about.
  await expect(
    page.getByRole('cell', { name: 'main.slowRegression' }),
  ).toBeVisible();
  await expectCanvasPainted(page.locator('.plfg-canvas-graph canvas').first());
});

test('the tag explorer breaks the profile down by label', async ({ page }) => {
  await page.goto(url('/explore', { groupBy: 'region' }));

  const table = page.locator('.tag-explorer-table');
  await expect(table).toBeVisible();
  for (const region of ['us-east', 'eu-west', 'ap-south']) {
    await expect(table.getByText(region, { exact: true })).toBeVisible();
  }

  // Shares are a percentage of *every* group's total, not of the rows on
  // screen, so a breakdown truncated to the top 8 sums to less than 100 —
  // never to more. Asserting ~100 unconditionally would re-encode the bug
  // where the visible slice was rebased to itself, and would start failing
  // the day the fixtures are re-recorded against more label values.
  const shares = await table.locator('.tag-explorer-num').allInnerTexts();
  const percentages = shares
    .filter((text) => text.endsWith('%'))
    .map((text) => Number.parseFloat(text));
  expect(percentages.length).toBeGreaterThan(0);
  const total = percentages.reduce((sum, value) => sum + value, 0);
  expect(total).toBeLessThan(101);
  const rows = await table.locator('tbody tr').count();
  if (rows < 8) {
    // Nothing was truncated, so these rows are the whole profile.
    expect(total).toBeGreaterThan(99);
  }
});

test('the tag explorer groups by the label the URL names', async ({ page }) => {
  await page.goto(url('/explore', { groupBy: 'region' }));
  await expect(page.locator('.tag-explorer-table')).toBeVisible();

  const grouped = (await upstreamLog(page)).filter(
    (entry) => entry.method === 'SelectSeries' && entry.groupBy,
  );
  expect(grouped.some((entry) => entry.groupBy?.includes('region'))).toBe(true);
});

test('an empty profile says so instead of drawing nothing', async ({
  page,
}) => {
  // A selector that matches nothing, which the fake upstream answers the way
  // the real server does: a single root of width zero.
  await page.goto(
    url('/', {
      query: `{service_name="nope", profile_type="${meta.profileType}"}`,
    }),
  );

  const empty = page.locator('.empty').first();
  await expect(empty).toBeVisible();
  // And it is still empty once the response has landed. Asserting only that
  // the placeholder appeared would pass on the flash of it shown while the
  // first request is in flight, whatever the answer turned out to be — which
  // is how this test came to fail once on main and pass everywhere else.
  await expect(page.locator('.plfg-canvas-graph')).toHaveCount(0);
  await expect(empty).toBeVisible();
});
