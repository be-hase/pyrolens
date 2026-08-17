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
