import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchFlamegraph, fetchTimeline } from '@api/client';
import { SingleView } from './SingleView.tsx';
import type { ViewProps } from '../App.tsx';

// Real profileTypeLabel/profileTypeUnit/sortProfileTypes etc. are kept —
// only the two network calls this view actually drives are replaced — so
// ControlsBar, QueryBar and TimeSeries render exactly as they do in the app.
vi.mock('@api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api/client')>();
  return {
    ...actual,
    fetchFlamegraph: vi.fn(),
    fetchTimeline: vi.fn(),
  };
});

// jsdom has no ResizeObserver at all (see AGENTS.md's "Verifying a change");
// TimeSeries observes its container to size the canvas backing store. A
// no-op stub is enough — the canvas draw effect itself bails out while width
// stays 0, so this test never needs a real canvas context.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const flamegraphOf = vi.mocked(fetchFlamegraph);
const timelineOf = vi.mocked(fetchTimeline);

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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  timelineOf.mockResolvedValue([]);
  flamegraphOf.mockResolvedValue({ names: [], levels: [] });
});

// SingleView reads maxNodes straight off the URL (useRoute()), the same way
// App.test.tsx drives routing — set the URL before rendering, not through a
// prop, and put it back so no other test in this file inherits it.
const at = (url: string) => window.history.replaceState(null, '', url);

describe('SingleView maxNodes wiring', () => {
  afterEach(() => {
    at('/');
  });

  it('passes a deep-linked maxNodes through to fetchFlamegraph', async () => {
    at('/?maxNodes=500');
    render(<SingleView {...PROPS} />);
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    // Second positional arg after the query params — see fetchFlamegraph's
    // signature in src/api/client.ts.
    assert.equal(flamegraphOf.mock.calls[0][1], 500);
  });
});

describe('SingleView retry wiring', () => {
  it('retries the failed fetch when Retry is clicked', async () => {
    flamegraphOf.mockRejectedValue(new Error('upstream is down'));
    render(<SingleView {...PROPS} />);

    const banner = await screen.findByRole('alert');
    assert.match(banner.textContent ?? '', /upstream is down/);
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    fireEvent.click(retryButton);
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 2));
  });

  it('shows a malformed query message without a Retry button', async () => {
    render(<SingleView {...PROPS} query='{unclosed="a"' />);

    const banner = await screen.findByRole('alert');
    assert.match(banner.textContent ?? '', /Could not parse the query/);
    // No fetch was ever attempted for this query, so there is nothing a
    // Retry click could usefully do — see useProfileData.ts.
    assert.ok(!screen.queryByRole('button', { name: 'Retry' }));
    assert.equal(flamegraphOf.mock.calls.length, 0);
  });
});

describe('SingleView empty flamegraph messaging', () => {
  it('does not claim a query matched nothing when no query was selected', async () => {
    // query='' is deliberately preserved (see App.tsx) rather than defaulted
    // away, and splitQuery('').profileTypeID is falsy, so useFlamegraph
    // never sends a fetch (active=false in useProfileData.ts). Asserting
    // "no profiles matched this query" — plus a "Last 24 hours" action that
    // cannot help — would claim a result for a query never sent.
    render(<SingleView {...PROPS} query="" />);

    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 0));
    assert.ok(
      !screen.queryByText(/No profiles matched this query in this range/),
    );
    assert.ok(!screen.queryByRole('button', { name: 'Last 24 hours' }));
  });
});
