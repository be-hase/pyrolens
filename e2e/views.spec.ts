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
  // The browser runs as ja-JP (playwright.config.ts). The axis only reaches
  // its date branch at a day-scale tick step, which tickStepMs picks between
  // roughly 6 and 12 days — a shorter range gets 12-hour steps and HH:MM
  // labels, which would not exercise this at all. The labels must come from
  // the project's own helpers; a `toLocale*` here renders 1月2日, and has.
  const day = 86_400_000;
  await page.goto(
    url('/', {
      from: meta.window.end - 10 * day,
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

test('deep-linking fgSearch prefills the flame graph search box', async ({
  page,
}) => {
  await page.goto(url('/', { fgSearch: 'queryDatabase' }));
  await expect(page.getByRole('textbox', { name: 'Search' })).toHaveValue(
    'queryDatabase',
  );
});

test('typing into the flame graph search box writes fgSearch to the URL, and clearing it removes the param', async ({
  page,
}) => {
  await page.goto(url('/'));
  const search = page.getByRole('textbox', { name: 'Search' });

  await search.fill('queryDatabase');
  // Two debounces sit between a keystroke and the URL: the vendored
  // header's own (250ms) feeding the wrapper's controlled search, then the
  // wrapper's own (400ms) before it writes fgSearch. Poll rather than wait
  // a fixed time so the assertion doesn't race either one.
  await expect
    .poll(() => new URL(page.url()).searchParams.get('fgSearch'), {
      timeout: 5_000,
    })
    .toBe('queryDatabase');

  await search.fill('');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('fgSearch'), {
      timeout: 5_000,
    })
    .toBeNull();
});

test('the comparison view shares fgSearch across both panes', async ({
  page,
}) => {
  await page.goto(
    url('/comparison', {
      fgSearch: 'queryDatabase',
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );

  // Both panes render their own flame graph header, so both should show the
  // one shared value rather than each tracking its own.
  const searches = page.getByRole('textbox', { name: 'Search' });
  await expect(searches).toHaveCount(2);
  await expect(searches.nth(0)).toHaveValue('queryDatabase');
  await expect(searches.nth(1)).toHaveValue('queryDatabase');
});

test('typing into one Comparison pane settles the URL on the typed value instead of ping-ponging, and the other pane converges to it', async ({
  page,
}) => {
  // Both panes' FlameGraph wrappers read/write the same fgSearch param. A
  // debounced write effect that cannot tell its own settled edit from a
  // stale echo of the other pane's commit ping-pongs the two panes'
  // debounces against each other instead of settling — this test exists to
  // catch that regressing.
  await page.goto(
    url('/comparison', {
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );

  const searches = page.getByRole('textbox', { name: 'Search' });
  await expect(searches).toHaveCount(2);

  // Count `pyroscope:navigate` dispatches from inside the page rather than
  // polling `page.url()` from Node: a livelock's ping-pong settles for good
  // within a handful of debounce/render cycles (React batches the
  // navigate()-triggers-a-rerender-triggers-navigate() chain faster than a
  // few dozen milliseconds), well inside the granularity Node-side URL
  // polling can resolve — this measured ~50 navigations for a single typed
  // value against the unfixed effect, versus 1 once fixed.
  await page.evaluate(() => {
    (window as unknown as { __navCount: number }).__navCount = 0;
    window.addEventListener('pyroscope:navigate', () => {
      (window as unknown as { __navCount: number }).__navCount++;
    });
  });

  await searches.nth(0).fill('queryDatabase');

  await expect
    .poll(() => new URL(page.url()).searchParams.get('fgSearch'), {
      timeout: 5_000,
    })
    .toBe('queryDatabase');
  await expect(searches.nth(1)).toHaveValue('queryDatabase');

  // Give a livelock a further debounce cycle's worth of time to keep
  // flapping before reading the final tally.
  await page.waitForTimeout(1_000);
  const navCount = await page.evaluate(
    () => (window as unknown as { __navCount: number }).__navCount,
  );
  expect(navCount).toBeLessThan(10);
});

test('fgSandwich deep link renders the sandwich pill, and its close control clears the param', async ({
  page,
}) => {
  await page.goto(url('/', { fgSandwich: 'main.queryDatabase' }));

  // FlameGraphMetadata renders the sandwich pill in a wrapper titled with
  // the sandwiched label — a stable locator that doesn't require driving
  // the canvas context menu that normally sets a sandwich. Scoped to
  // .plfg-metadata: the top table's own symbol cell carries the same title.
  const pill = page.locator('.plfg-metadata').getByTitle('main.queryDatabase');
  await expect(pill).toBeVisible();

  await pill.getByRole('button', { name: 'Remove sandwich view' }).click();

  await expect
    .poll(() => new URL(page.url()).searchParams.get('fgSandwich'), {
      timeout: 5_000,
    })
    .toBeNull();
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

test('the diff view honours a deep-linked fgSearch, instead of the uncontrolled container silently ignoring it', async ({
  page,
}) => {
  await page.goto(
    url('/diff', {
      fgSearch: 'queryDatabase',
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );

  await expect(page.getByRole('textbox', { name: 'Search' })).toHaveValue(
    'queryDatabase',
  );
});

test('the tag explorer breaks the profile down by label', async ({ page }) => {
  await page.goto(url('/explore', { groupBy: 'region' }));

  const table = page.locator('.tag-explorer-table');
  await expect(table).toBeVisible();
  for (const region of ['us-east', 'eu-west', 'ap-south']) {
    await expect(table.getByText(region, { exact: true })).toBeVisible();
  }

  // The table lists every row (only the chart above is capped at 8), so
  // shares — a percentage of *every* group's total — should sum to ~100
  // regardless of how many rows the fixture has. Asserting a tight bound
  // here would re-encode the old truncation bug, where a visible slice was
  // rebased to itself and summed to more than 100.
  const shares = await table.locator('.tag-explorer-num').allInnerTexts();
  const percentages = shares
    .filter((text) => text.endsWith('%'))
    .map((text) => Number.parseFloat(text));
  expect(percentages.length).toBeGreaterThan(0);
  const total = percentages.reduce((sum, value) => sum + value, 0);
  expect(total).toBeGreaterThan(99);
  expect(total).toBeLessThan(101);
});

test('sorting the breakdown table by a column writes it to the URL', async ({
  page,
}) => {
  await page.goto(url('/explore', { groupBy: 'region' }));
  const table = page.locator('.tag-explorer-table');
  await expect(table).toBeVisible();

  await table.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page).toHaveURL(/[?&]sort=max(&|$)/);
  await expect(
    table.locator('th[aria-sort="descending"]', { hasText: 'Max' }),
  ).toBeVisible();

  // Clicking the active header again returns to the default ranking.
  await table.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]sort=/);
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
