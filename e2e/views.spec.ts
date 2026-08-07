import { expect, test } from '@playwright/test';
import {
  clearUpstreamLog,
  expectCanvasPainted,
  failOnPageErrors,
  meta,
  upstreamLog,
  url,
} from './helpers.ts';

// The four views, rendered by the real binary from the real wire format.
// Everything here is out of reach of the unit tests: the embedded assets, the
// proxy, and the decode that ends in a canvas.

// The fake upstream's request log is shared, so every spec starts from an
// empty one.
test.beforeEach(async ({ page }) => {
  failOnPageErrors(page);
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

  // Shares are a percentage of the total, so they have to add up.
  const shares = await table.locator('.tag-explorer-num').allInnerTexts();
  const percentages = shares
    .filter((text) => text.endsWith('%'))
    .map((text) => Number.parseFloat(text));
  expect(percentages.length).toBeGreaterThan(0);
  const total = percentages.reduce((sum, value) => sum + value, 0);
  expect(total).toBeGreaterThan(99);
  expect(total).toBeLessThan(101);
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
  // A query for a profile type the fixtures have nothing for.
  await page.goto(
    url('/', { query: '{service_name="nope", profile_type="a:b:c:d:e"}' }),
  );
  await expect(page.locator('.empty').first()).toBeVisible();
});
