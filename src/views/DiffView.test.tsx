import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchDiffFlamegraph, fetchTimeline } from '@api/client';
import { DiffView } from './DiffView.tsx';
import type { ViewProps } from '../App.tsx';

// Real profileTypeUnit/parseMaxNodes/etc. are kept — only the two network
// calls this view (and the ComparisonPane timelines it renders) actually
// drive are replaced. See SingleView.test.tsx's identical reasoning.
vi.mock('@api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api/client')>();
  return {
    ...actual,
    fetchDiffFlamegraph: vi.fn(),
    fetchTimeline: vi.fn(),
  };
});

// jsdom has no ResizeObserver (see AGENTS.md's "Verifying a change"); the
// pane timelines observe their container to size the canvas backing store.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const diffOf = vi.mocked(fetchDiffFlamegraph);
const timelineOf = vi.mocked(fetchTimeline);

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const ALLOC = 'memory:alloc_objects:count:space:bytes';
const QUERY = `{service_name="web", profile_type="${CPU}"}`;

const PROPS: ViewProps = {
  services: [],
  servicesLoading: false,
  query: QUERY,
  from: 'now-1h',
  until: 'now',
  range: { start: 1_000_000, end: 4_600_000 },
};

// DiffView reads leftQuery/rightQuery straight off the URL (useRoute(),
// via useComparisonParams), the same way SingleView.test.tsx drives
// maxNodes — set the URL before rendering, not through a prop, and put it
// back so no other test in this file inherits it.
const at = (url: string) => window.history.replaceState(null, '', url);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  timelineOf.mockResolvedValue([]);
  diffOf.mockResolvedValue({ names: [], levels: [] });
});

afterEach(() => {
  at('/');
});

describe('DiffView profile-type mismatch', () => {
  it('does not request a diff and explains the mismatch when panes name different profile types', async () => {
    const params = new URLSearchParams();
    params.set('rightQuery', `{service_name="api", profile_type="${ALLOC}"}`);
    at(`/?${params.toString()}`);

    render(<DiffView {...PROPS} />);

    // Both pane timelines still fetch independently (see ComparisonPane) —
    // it is only the Diff RPC, which assumes matching types, that must be
    // withheld.
    await waitFor(() => assert.equal(timelineOf.mock.calls.length, 2));
    assert.equal(diffOf.mock.calls.length, 0);

    const message = await screen.findByText(
      /Diff needs both panes to query the same profile type/,
    );
    assert.match(message.textContent ?? '', new RegExp(CPU));
    assert.match(message.textContent ?? '', new RegExp(ALLOC));

    // The natural way out: align the Comparison pane to Baseline's query.
    const alignButton = screen.getByRole('button', {
      name: /Match Comparison to Baseline/,
    });
    assert.ok(alignButton);
  });

  it('requests the diff when both panes name the same profile type', async () => {
    // Regression: the ordinary case (both panes inherit the main query, so
    // both sides are the same profile type) must still fetch.
    render(<DiffView {...PROPS} />);

    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));
    assert.ok(!screen.queryByText(/Diff needs both panes to query the same/));
  });

  it('"Match Comparison to Baseline" deletes rightQuery, not materializes it, when the left pane is inheriting', async () => {
    // The mismatch here comes entirely from a rightQuery override — there is
    // no leftQuery param, so the left pane inherits the main query. The
    // action must write left's raw override (null) so the right pane goes
    // back to inheriting too, not the left pane's *resolved* query — writing
    // the resolved string would permanently detach the right pane from the
    // main query, so later edits to the main query would stop propagating.
    const params = new URLSearchParams();
    params.set('rightQuery', `{service_name="api", profile_type="${ALLOC}"}`);
    at(`/?${params.toString()}`);

    render(<DiffView {...PROPS} />);

    const alignButton = await screen.findByRole('button', {
      name: /Match Comparison to Baseline/,
    });
    fireEvent.click(alignButton);

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('rightQuery'),
        null,
      ),
    );
  });

  it('"Match Comparison to Baseline" copies the left pane\'s override string when it has one', async () => {
    // When the left pane *is* explicitly overridden, the right pane should
    // take that same raw override so both panes match afterward.
    const leftOverride = `{service_name="web2", profile_type="${CPU}"}`;
    const params = new URLSearchParams();
    params.set('leftQuery', leftOverride);
    params.set('rightQuery', `{service_name="api", profile_type="${ALLOC}"}`);
    at(`/?${params.toString()}`);

    render(<DiffView {...PROPS} />);

    const alignButton = await screen.findByRole('button', {
      name: /Match Comparison to Baseline/,
    });
    fireEvent.click(alignButton);

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('rightQuery'),
        leftOverride,
      ),
    );
  });
});
