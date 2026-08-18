import { render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchGroupedTimelines, fetchLabelNames } from '@api/client';
import { TagExplorerView } from './TagExplorerView.tsx';
import type { ViewProps } from '../App.tsx';

// Only the two network calls this view actually drives are replaced — see
// SingleView.test.tsx for the same rationale.
vi.mock('@api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api/client')>();
  return {
    ...actual,
    fetchGroupedTimelines: vi.fn(),
    fetchLabelNames: vi.fn(),
  };
});

const groupedTimelinesOf = vi.mocked(fetchGroupedTimelines);
const labelNamesOf = vi.mocked(fetchLabelNames);

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const QUERY = `{service_name="web", profile_type="${CPU}"}`;

const PROPS: ViewProps = {
  services: [],
  servicesLoading: false,
  servicesSettled: true,
  query: QUERY,
  from: 'now-1h',
  until: 'now',
  range: { start: 1_000_000, end: 4_600_000 },
};

// TagExplorerView reads groupBy straight off the URL (useRoute()), the same
// way SingleView.test.tsx drives maxNodes — set the URL before rendering,
// not through a prop, and put it back so no other test in this file inherits
// it.
const at = (url: string) => window.history.replaceState(null, '', url);

beforeEach(() => {
  groupedTimelinesOf.mockResolvedValue([]);
});

afterEach(() => {
  at('/');
});

describe('TagExplorerView stale groupBy reset', () => {
  it('replace-navigates to the first label when the deep-linked groupBy is not in the fetched list', async () => {
    at('/?groupBy=region');
    // The query switched to a service that has no "region" label — the
    // fetched list no longer contains the value the URL still names.
    labelNamesOf.mockResolvedValue(['pod', 'namespace']);
    const pushSpy = vi.spyOn(window.history, 'pushState');

    render(<TagExplorerView {...PROPS} />);

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('groupBy'),
        'namespace',
      ),
    );
    // The reset must not create a history entry a stray Back would have to
    // undo — same replace() the empty-groupBy default path already uses.
    assert.equal(pushSpy.mock.calls.length, 0);
  });

  it('leaves a valid groupBy alone once its label is confirmed present', async () => {
    at('/?groupBy=region');
    labelNamesOf.mockResolvedValue(['region', 'pod']);

    render(<TagExplorerView {...PROPS} />);

    await waitFor(() => assert.equal(groupedTimelinesOf.mock.calls.length, 1));
    assert.equal(
      new URLSearchParams(window.location.search).get('groupBy'),
      'region',
    );
  });

  it('resets a confirmed groupBy once the query changes to one whose labels lack it', async () => {
    at('/?groupBy=region');
    // First fetch, under the original query, confirms "region".
    labelNamesOf.mockResolvedValueOnce(['region', 'pod']);

    const { rerender } = render(<TagExplorerView {...PROPS} />);
    await waitFor(() => assert.equal(groupedTimelinesOf.mock.calls.length, 1));
    assert.equal(
      new URLSearchParams(window.location.search).get('groupBy'),
      'region',
    );

    // The query switches to a different service — a real query change, not
    // just a range tick — and its label list has no "region".
    const OTHER_QUERY = `{service_name="other", profile_type="${CPU}"}`;
    labelNamesOf.mockResolvedValueOnce(['pod', 'namespace']);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    rerender(<TagExplorerView {...PROPS} query={OTHER_QUERY} />);

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('groupBy'),
        'namespace',
      ),
    );
    assert.equal(pushSpy.mock.calls.length, 0);
  });

  it('keeps a confirmed groupBy through a later same-query refetch that omits it', async () => {
    at('/?groupBy=region');
    // First labels fetch, under this query, confirms "region" is valid.
    labelNamesOf.mockResolvedValueOnce(['region', 'pod']);

    const { rerender } = render(<TagExplorerView {...PROPS} />);
    await waitFor(() => assert.equal(groupedTimelinesOf.mock.calls.length, 1));
    assert.equal(
      new URLSearchParams(window.location.search).get('groupBy'),
      'region',
    );

    // A relative range's "now" advances on every navigation and every
    // auto-refresh tick (see AGENTS.md's "State and navigation"), and the
    // labels fetch is keyed on range.start/range.end — so it refires under
    // the *same* query on every such tick. App.tsx is what recomputes
    // `range` and passes it down as a prop on each of those renders, so
    // rerendering with a new range (same query/labelSelector) is that exact
    // mechanism, not a stand-in for it. Simulate the label sliding out of a
    // moving window: the same query's list momentarily omits "region".
    labelNamesOf.mockResolvedValueOnce(['pod', 'namespace']);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    rerender(
      <TagExplorerView
        {...PROPS}
        range={{ start: 2_000_000, end: 5_600_000 }}
      />,
    );

    // Wait for the second labels fetch to have settled and rendered (the
    // group-by chip row reflects the new list) before asserting nothing
    // clobbered the URL — the reset effect (if any) runs in the same
    // commit as this data landing.
    await waitFor(() => assert.ok(screen.queryByText('namespace')));

    assert.equal(
      new URLSearchParams(window.location.search).get('groupBy'),
      'region',
    );
    assert.equal(pushSpy.mock.calls.length, 0);
  });

  it('resets a confirmed groupBy once the tenant switches to one whose labels lack it', async () => {
    at('/?groupBy=region');
    // First fetch, under tenant A, confirms "region".
    labelNamesOf.mockResolvedValueOnce(['region', 'pod']);

    const { rerender } = render(
      <TagExplorerView {...PROPS} tenantID="tenant-a" />,
    );
    await waitFor(() => assert.equal(groupedTimelinesOf.mock.calls.length, 1));
    assert.equal(
      new URLSearchParams(window.location.search).get('groupBy'),
      'region',
    );

    // The tenant switches — same query, same selector — but tenant B's
    // label list has no "region".
    labelNamesOf.mockResolvedValueOnce(['pod', 'namespace']);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    rerender(<TagExplorerView {...PROPS} tenantID="tenant-b" />);

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('groupBy'),
        'namespace',
      ),
    );
    assert.equal(pushSpy.mock.calls.length, 0);
  });
});

describe('TagExplorerView loading placeholder', () => {
  it('shows the loading indicator in the timeline chart while the grouped fetch is pending with no series yet', async () => {
    at('/?groupBy=region');
    labelNamesOf.mockResolvedValue(['region', 'pod']);
    groupedTimelinesOf.mockReturnValue(new Promise(() => {}));

    const { container } = render(<TagExplorerView {...PROPS} />);

    await waitFor(() =>
      assert.ok(
        container.querySelector('.loading'),
        'expected the Loading placeholder in the timeline chart while grouped timelines are pending',
      ),
    );
  });

  it('shows the loading indicator in the Breakdown panel while the grouped fetch is pending', async () => {
    at('/?groupBy=region');
    labelNamesOf.mockResolvedValue(['region', 'pod']);
    groupedTimelinesOf.mockReturnValue(new Promise(() => {}));

    const { container } = render(<TagExplorerView {...PROPS} />);

    // Both the timeline chart (MultiTimeSeries) and the Breakdown panel
    // render their own Loading placeholder off the same `loading` flag —
    // asserting the count is 2 pins this to the Breakdown panel too, not
    // just whichever renders first.
    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        2,
        'expected Loading placeholders in both the timeline chart and the Breakdown panel',
      ),
    );
  });

  it('keeps rendering the chart, not the loading indicator, when a refetch is pending over already-loaded series', async () => {
    at('/?groupBy=region');
    labelNamesOf.mockResolvedValue(['region', 'pod']);
    groupedTimelinesOf.mockResolvedValueOnce([
      { labelValue: 'a', points: [{ timestamp: 1_000_000, value: 5 }] },
    ]);

    const { container, rerender } = render(<TagExplorerView {...PROPS} />);
    await waitFor(() => assert.ok(container.querySelector('.timeseries-svg')));

    // A range tick (see AGENTS.md: "now" advances on every navigation)
    // refires the grouped fetch under the same query/groupBy while the
    // previous series are still on screen — stale-while-refetching per
    // useFetched's contract. Keep the refetch pending so `loading` stays
    // true with `series` still non-empty.
    groupedTimelinesOf.mockReturnValue(new Promise(() => {}));
    rerender(
      <TagExplorerView
        {...PROPS}
        range={{ start: 2_000_000, end: 5_600_000 }}
      />,
    );

    await waitFor(() => assert.equal(groupedTimelinesOf.mock.calls.length, 2));
    assert.ok(
      container.querySelector('.timeseries-svg'),
      'the chart must keep rendering over existing series even while a refresh is in flight',
    );
    assert.ok(
      !container.querySelector('.loading'),
      'the loading placeholder must not replace a chart that already has series',
    );
  });
});

describe('TagExplorerView label-fetch stage', () => {
  it('shows the loading indicator in the timeline and breakdown panels while labels are still fetching, before groupBy has a default', async () => {
    // No groupBy in the URL and the labels fetch never settles — `active`
    // (profileTypeID && groupBy) is false the whole time, so `loading` alone
    // stays false even though the label fetch, a prerequisite stage of the
    // same pipeline, is still working.
    at('/');
    labelNamesOf.mockReturnValue(new Promise(() => {}));

    const { container } = render(<TagExplorerView {...PROPS} />);

    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        2,
        'expected the Loading placeholder in both the timeline chart and the Breakdown panel while labels are in flight',
      ),
    );
    assert.ok(
      !screen.queryByText(/No profiles matched this query in this range/),
      'must not claim no profiles matched while the label fetch is still pending',
    );
  });
});

describe('TagExplorerView startup gap before the default query resolves', () => {
  it('shows the loading indicator instead of "No profiles matched" while services have never settled and no query has been selected yet', async () => {
    // Mirrors App.tsx: before the services fetch settles, no default query
    // has been written into the URL, so `query` is '' and profileTypeID is
    // empty — not because nothing matched, but because nothing has been
    // asked yet.
    at('/');

    const { container } = render(
      <TagExplorerView
        {...PROPS}
        query=""
        servicesLoading
        servicesSettled={false}
        services={[]}
      />,
    );

    await waitFor(() =>
      assert.ok(
        container.querySelector('.loading'),
        'expected the Loading placeholder while services are still resolving the default query',
      ),
    );
    assert.ok(
      !screen.queryByText(/No profiles matched this query in this range/),
    );
  });
});

describe('TagExplorerView due-navigation gap before the default query lands (FINDING 3)', () => {
  it('shows the loading indicator instead of "No profiles matched" once services settle non-empty but the URL still has no query param', async () => {
    // App's default-query effect (App.tsx) is about to write a `query`
    // param — services arrived and the URL has none — but this view is
    // rendered in isolation here (not via App), so that write never lands.
    // Before FIX 3, this window read as "profileTypeID empty and
    // servicesLoading is (by now) false", which fell through to the false
    // "No profiles matched" conclusion.
    at('/');

    const { container } = render(
      <TagExplorerView
        {...PROPS}
        query=""
        servicesSettled
        services={[{ name: 'web', profileTypes: [CPU] }]}
      />,
    );

    await waitFor(() =>
      assert.ok(
        container.querySelector('.loading'),
        'expected the Loading placeholder while the default-query write is due',
      ),
    );
    assert.ok(
      !screen.queryByText(/No profiles matched this query in this range/),
    );
  });
});

describe('TagExplorerView settled-empty labels stay honest through a background refetch (FINDING 1)', () => {
  it('keeps showing the "nothing to break down" conclusion — never the loading placeholder — through a range-driven labels refetch', async () => {
    // No groupBy in the URL; labels resolve to an empty list — a query with
    // nothing to group by. This is a settled, honest conclusion, not a
    // startup gap, and must not flicker back to the loading placeholder on
    // a later tick: the labels fetch is keyed on range.start/range.end,
    // which changes on every auto-refresh tick (AGENTS.md's "now advances
    // on every navigation"). Before FIX 1, `settingUp` read
    // `labels.fetching` directly and pulsed true again on each such tick.
    at('/');
    labelNamesOf.mockResolvedValueOnce([]);

    const { container, rerender } = render(<TagExplorerView {...PROPS} />);

    const EMPTY_MESSAGE =
      /No profiles matched this query in this range, so there is nothing to break down/;
    await waitFor(() => assert.ok(screen.getByText(EMPTY_MESSAGE)));
    assert.ok(!container.querySelector('.loading'));

    // Simulate an auto-refresh tick: range changes, so the labels fetch (and
    // the grouped fetch) refire under the same query — held pending (not
    // resolved) so the assertion below lands deterministically while
    // `labels.fetching` is genuinely true, rather than racing a promise that
    // may already have settled again by the time the assertion runs.
    labelNamesOf.mockReturnValue(new Promise(() => {}));
    rerender(
      <TagExplorerView
        {...PROPS}
        range={{ start: 2_000_000, end: 5_600_000 }}
      />,
    );

    await waitFor(() => assert.equal(labelNamesOf.mock.calls.length, 2));
    assert.ok(screen.getByText(EMPTY_MESSAGE));
    assert.ok(!container.querySelector('.loading'));
  });
});

// FINDING 3(a)'s specific bug — one committed frame of the false empty
// conclusion between labels settling non-empty and the default-groupBy
// effect's replace-navigation landing — is proven directly and
// deterministically by breakdownSettingUp's unit tests
// (tagExplorerData.test.ts): with the fix, `settingUp` (and therefore
// `stillWorking`) is true at every render where `groupBy` is still empty and
// `labels.data` is non-empty, by construction, regardless of whether
// `labels.settled` has flipped in that same render. A component-level test
// attempting to catch the literal one-frame gap here was tried and dropped:
// RTL/React's `act()` flushes the labels-fetch state update and the
// following default-groupBy effect (itself a synchronous chain through
// useRoute's useSyncExternalStore) to a stable point before any assertion
// can run, even when draining only microtasks — so the transient render is
// never independently observable through the rendered DOM in this
// environment. The wiring this drives (`stillWorking` swapping the
// Breakdown panel between Loading and the table) already has coverage above
// ("TagExplorerView loading placeholder" / "label-fetch stage").

describe('TagExplorerView ControlsBar', () => {
  it('does not render the Max nodes slider — there is no flame graph here', () => {
    render(<TagExplorerView {...PROPS} />);
    assert.ok(!screen.queryByRole('slider', { name: 'Max nodes' }));
  });
});
