import { expect, test, type Page } from '@playwright/test';
import { splitQuery } from '../src/queryLang.ts';
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

  // Not just that *some* request landed: a stale-query desync would replay
  // the same fixture and pass anyway (the fake answers whatever it is sent,
  // e2e/README.md), so this asserts the logged selector against splitQuery's
  // normalized form of the edited query — what the API actually receives
  // once the profile_type pseudo-label is peeled off.
  const expectedSelector = splitQuery(edited).labelSelector;
  await expect
    .poll(async () => {
      const calls = (await upstreamLog(page)).filter(
        (entry) => entry.method === 'SelectMergeStacktraces',
      );
      return (
        calls.length > 0 &&
        calls.every((entry) => entry.labelSelector === expectedSelector)
      );
    })
    .toBe(true);
});

// Scoped to the picker's own wrapper. Matching a button by the shape of its
// label instead reached across the whole page and picked up whichever control
// happened to come first in the DOM.
const openRangePicker = (page: Page) =>
  page.locator('.time-range-picker').getByRole('button').first().click();

test('a time-range preset writes a relative from and drops until', async ({
  page,
}) => {
  await page.goto(url('/'));
  await openRangePicker(page);
  await page.getByText('Last 30 minutes').click();

  const params = new URL(page.url()).searchParams;
  expect(params.get('from')).toBe('now-30m');
  expect(params.has('until')).toBe(false);
});

test('the range picker applies an absolute window as unix milliseconds', async ({
  page,
}) => {
  await page.goto(url('/'));
  await openRangePicker(page);

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

test('copy absolute link bakes the resolved bounds without navigating', async ({
  page,
  context,
}) => {
  // Chromium against 127.0.0.1 is a secure context, so navigator.clipboard
  // exists; it still needs the permission grant to read/write without a
  // user gesture prompt.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto(url('/', { from: 'now-1h', until: 'now' }));
  await openRangePicker(page);
  await page.getByRole('button', { name: 'Copy absolute link' }).click();
  // Reading the clipboard races writeText; waiting for the button's own
  // "Copied" state is what actually orders the read after the write instead
  // of relying on Chromium happening to schedule them in that order.
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const copiedParams = new URL(copied).searchParams;
  expect(copiedParams.get('from')).toMatch(/^\d+$/);
  expect(copiedParams.get('until')).toMatch(/^\d+$/);
  // from=now-1h&until=now: the baked bounds must span that same hour, not
  // just be two numbers — a bug that baked the same instant twice for both
  // would still pass the regex checks above.
  expect(
    Number(copiedParams.get('until')) - Number(copiedParams.get('from')),
  ).toBe(3_600_000);

  // The screen itself must stay on the relative range: baking is for the
  // copied text only, not a navigation.
  const params = new URL(page.url()).searchParams;
  expect(params.get('from')).toBe('now-1h');
});

test('`y` switches the range to absolute, and is ignored while typing', async ({
  page,
}) => {
  await page.goto(url('/', { from: 'now-1h', until: 'now' }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const params = () => new URL(page.url()).searchParams;
  const trigger = page
    .locator('.time-range-picker')
    .getByRole('button')
    .first();
  await expect(trigger).toHaveText(/Last/);

  // Typing "y" into the query bar must add a letter, not fire the shortcut —
  // checked here, before the range goes absolute, because doing it after
  // would let a broken guard slip past: it would just rewrite the same
  // from/until the shortcut already wrote, and the assertions below would
  // still pass having proven nothing. The guard has to see the keydown's
  // target, not just the key.
  const input = page.getByRole('combobox');
  const before = await input.inputValue();
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.press('y');
  await expect(input).toHaveValue(`${before}y`);
  expect(params().get('from')).toBe('now-1h');
  expect(params().get('until')).toBe('now');

  // Move focus back to the page body so the next `y` is not swallowed by
  // the same guard that just proved itself.
  await input.blur();
  await page.keyboard.press('y');

  await expect.poll(() => params().get('from')).toMatch(/^\d+$/);
  expect(params().get('until')).toMatch(/^\d+$/);
  // The absolute label ("Aug 7 09:30 – ...") replaces the relative "Last 1h" —
  // that flip is the shortcut's only user-visible feedback.
  await expect(trigger).not.toHaveText(/Last/);
});

test('the `t a` sequence switches the range to absolute, mirroring `y`', async ({
  page,
}) => {
  await page.goto(url('/', { from: 'now-1h', until: 'now' }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const params = () => new URL(page.url()).searchParams;
  const trigger = page
    .locator('.time-range-picker')
    .getByRole('button')
    .first();
  await expect(trigger).toHaveText(/Last/);

  // Focus is on the page body here, not an input, so the sequence fires.
  await page.keyboard.press('t');
  await page.keyboard.press('a');

  await expect.poll(() => params().get('from')).toMatch(/^\d+$/);
  expect(params().get('until')).toMatch(/^\d+$/);
  await expect(trigger).not.toHaveText(/Last/);
});

test('the `t z` sequence zooms out 2x, centered on the current range', async ({
  page,
}) => {
  const from = new Date(2026, 0, 2, 9, 0, 0).getTime();
  const until = new Date(2026, 0, 2, 11, 0, 0).getTime();
  await page.goto(url('/', { from, until }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const params = () => new URL(page.url()).searchParams;

  await page.keyboard.press('t');
  await page.keyboard.press('z');

  const half = (until - from) / 2;
  await expect.poll(() => params().get('from')).toBe(String(from - half));
  expect(params().get('until')).toBe(String(until + half));
});

test('`t c` copies the range as Grafana JSON — relative as-is, absolute as ISO-8601 — and `t v` pastes it back', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto(url('/', { from: 'now-1h', until: 'now' }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const params = () => new URL(page.url()).searchParams;
  const trigger = page
    .locator('.time-range-picker')
    .getByRole('button')
    .first();
  const readClipboard = () =>
    page.evaluate(() => navigator.clipboard.readText());

  // `t c`: a relative range copies as Grafana's own clipboard shape — exactly
  // `{"from":"now-1h","to":"now"}`, so it pastes back into Grafana itself
  // unchanged.
  await page.keyboard.press('t');
  await page.keyboard.press('c');
  await expect(trigger).toHaveText('Copied');
  expect(JSON.parse(await readClipboard())).toEqual({
    from: 'now-1h',
    to: 'now',
  });

  // An absolute range copies as ISO-8601 UTC instead — the shape
  // `toISOString()` produces and current Grafana itself reads and writes.
  const absoluteFrom = new Date(2026, 0, 2, 9, 5, 0).getTime();
  const absoluteUntil = new Date(2026, 0, 2, 17, 30, 0).getTime();
  await page.goto(url('/', { from: absoluteFrom, until: absoluteUntil }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();
  await page.keyboard.press('t');
  await page.keyboard.press('c');
  await expect(trigger).toHaveText('Copied');
  expect(JSON.parse(await readClipboard())).toEqual({
    from: new Date(absoluteFrom).toISOString(),
    to: new Date(absoluteUntil).toISOString(),
  });

  // `t v`: seed the clipboard with an absolute, ISO-8601 range (current
  // Grafana's own format) and paste it back on a relative screen; the URL
  // should gain the equivalent unix-ms bounds. Date.parse of the same ISO
  // strings, not a hand-built local Date, keeps the expectation independent
  // of the runner's timezone.
  await page.goto(url('/', { from: 'now-1h', until: 'now' }));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();
  const fromIso = '2026-01-02T09:05:00.000Z';
  const toIso = '2026-01-02T17:30:00.000Z';
  await page.evaluate(
    (payload) => navigator.clipboard.writeText(JSON.stringify(payload)),
    { from: fromIso, to: toIso },
  );
  await page.keyboard.press('t');
  await page.keyboard.press('v');

  await expect
    .poll(() => params().get('from'))
    .toBe(String(Date.parse(fromIso)));
  expect(params().get('until')).toBe(String(Date.parse(toIso)));
});

// The picker is a core/Select whose trigger is named for screen readers as
// "Refresh interval: <value>" — locate it by that name, which also pins the
// accessible naming itself.
const refreshTrigger = (page: Page) =>
  page.getByRole('button', { name: /^Refresh interval/ });
const openRefreshPicker = (page: Page) => refreshTrigger(page).click();

test('the refresh picker writes the chosen interval to the URL, and Off removes it', async ({
  page,
}) => {
  // The unit tests (src/components/RefreshPicker.test.tsx) own the actual
  // ticking behaviour with fake timers; a real 10s+ wait here would only add
  // flake for something already covered, so this just checks the URL/label
  // round trip a click produces.
  await page.goto(url('/'));
  await openRefreshPicker(page);
  await page.getByRole('option', { name: '30s' }).click();

  const params = () => new URL(page.url()).searchParams;
  expect(params().get('refresh')).toBe('30s');
  await expect(refreshTrigger(page)).toHaveText('30s');

  await openRefreshPicker(page);
  await page.getByRole('option', { name: 'Off' }).click();
  expect(params().has('refresh')).toBe(false);
});

test('rapid Max nodes key presses coalesce into exactly one navigation and one refetch carrying the final value', async ({
  page,
}) => {
  await page.goto(url('/'));
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  const params = () => new URL(page.url()).searchParams;
  const slider = page.getByRole('slider', { name: 'Max nodes' });
  // No maxNodes in the URL, so the slider starts at its LEFTMOST (Default)
  // position — see MaxNodesControl.tsx's PRESETS/DEFAULT_INDEX: Default is
  // index 0 on purpose, so a stray nudge only ever makes the cap smaller (or
  // leaves it off), never bigger.
  await expect(slider).toHaveAttribute('aria-valuetext', 'Default');

  // Let the initial load's requests land before snapshotting the count —
  // same "poll until stable" idiom as views.spec.ts's fgSearch client-side
  // filtering test, so a still-in-flight initial fetch can't be mistaken
  // for one this interaction caused.
  let settled = -1;
  await expect
    .poll(async () => {
      const len = (
        await upstreamLog(page).then((log) =>
          log.filter((e) => e.method === 'SelectMergeStacktraces'),
        )
      ).length;
      if (len === settled) return 'stable';
      settled = len;
      return len;
    })
    .toBe('stable');
  const before = settled;

  await slider.focus();
  // Five presses fired back to back, well inside MaxNodesControl's 350ms
  // commit debounce: each fires its own native `change` (keyboard
  // auto-repeat does the same, one per repeat tick), stepping the index
  // 0 -> 5 (Default up to 8192). ArrowRight, not ArrowLeft: index 0 is a
  // hard stop (min={0}), so ArrowLeft from Default would be a no-op and
  // prove nothing here — that property has its own pin in
  // MaxNodesControl.test.tsx. A regression that committed — and therefore
  // refetched — per keystroke instead of coalescing the burst would show up
  // below as more than one new request, or a request that isn't the final
  // value.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
  }

  await expect.poll(() => params().get('maxNodes')).toBe('8192');
  await expect(slider).toHaveAttribute('aria-valuetext', '8k');

  // Margin past the 350ms debounce plus the fetch it triggers.
  await page.waitForTimeout(800);
  const stacktraces = (await upstreamLog(page)).filter(
    (entry) => entry.method === 'SelectMergeStacktraces',
  );
  expect(stacktraces.length).toBe(before + 1);
  expect(stacktraces[stacktraces.length - 1].maxNodes).toBe(8192);
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

test('Reset view clears every accumulated param, keeps tenant/service/profile_type, and refetches under the reset state', async ({
  page,
}) => {
  // A URL messy with an extra query matcher plus one param from most of the
  // RESETS categories: the range, refresh, both Tag Explorer params (harmless
  // here but exercises the generic "clear every current key" mechanism
  // rather than a hardcoded list), the flame graph search/sandwich,
  // maxNodes, and both comparison panes' window overrides. leftQuery/
  // rightQuery are left alone (inheriting the main query, the default) —
  // overriding them to `{}` would leave both panes on "No query selected"
  // and there would be nothing to assert a fetch against.
  await page.goto(
    url('/comparison', {
      query: `{service_name="${meta.service}", profile_type="${meta.profileType}", region="eu-west"}`,
      refresh: '30s',
      groupBy: 'region',
      sort: 'max',
      fgSearch: 'queryDatabase',
      fgSandwich: 'main.queryDatabase',
      maxNodes: 500,
      leftFrom: meta.left.start,
      leftUntil: meta.left.end,
      rightFrom: meta.right.start,
      rightUntil: meta.right.end,
    }),
  );
  await expect(page.locator('.plfg-metadata-pill').first()).toBeVisible();

  // Let every request the initial load caused actually land before clearing
  // the log — refresh=30s is live until the click, and on a slow CI runner a
  // straggler under the OLD (region-matcher) selector could otherwise be
  // logged after the clear but before the click, landing in the same window
  // the poll below reads and failing its `every()` check for good rather
  // than just flaking. Same "poll until stable" idiom as the Max nodes
  // coalescing test above.
  let settled = -1;
  await expect
    .poll(async () => {
      const len = (
        await upstreamLog(page).then((log) =>
          log.filter((e) => e.method === 'SelectMergeStacktraces'),
        )
      ).length;
      if (len === settled) return 'stable';
      settled = len;
      return len;
    })
    .toBe('stable');

  await clearUpstreamLog(page);
  await page.getByRole('button', { name: 'Reset view' }).click();

  // Pathname is untouched — this is a param reset, not a view change.
  await expect(page).toHaveURL(/^[^?]*\/comparison\?/);
  const params = new URL(page.url()).searchParams;
  expect([...params.keys()].sort()).toEqual(['query', 'tenant']);
  expect(params.get('tenant')).toBe(meta.tenant);
  expect(params.get('query')).toBe(
    `{service_name="${meta.service}", profile_type="${meta.profileType}"}`,
  );

  // Not just that the URL changed: the region matcher actually dropped out
  // of what was sent upstream, proving the reset state was really refetched
  // rather than the old response staying on screen.
  const expectedSelector = `{service_name="${meta.service}"}`;
  await expect
    .poll(async () => {
      const calls = (await upstreamLog(page)).filter(
        (entry) => entry.method === 'SelectMergeStacktraces',
      );
      return (
        calls.length > 0 &&
        calls.every((entry) => entry.labelSelector === expectedSelector)
      );
    })
    .toBe(true);
});
