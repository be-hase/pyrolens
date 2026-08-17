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
  servicesSettled: true,
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

describe('SingleView startup gap before the default query resolves', () => {
  afterEach(() => {
    at('/');
  });

  it('shows the loading indicator instead of "No query selected." while services have never settled', async () => {
    // Mirrors App.tsx: before the services fetch settles, no default query
    // has been written into the URL yet, so query='' and profileTypeID is
    // empty — that is a startup gap, not a query that matched nothing.
    at('/');
    const { container } = render(
      <SingleView {...PROPS} query="" servicesSettled={false} services={[]} />,
    );

    await waitFor(() =>
      assert.ok(
        container.querySelector('.loading'),
        'expected the Loading placeholder in the flamegraph body while services resolve the default query',
      ),
    );
    assert.ok(!screen.queryByText('No query selected.'));
  });

  it('shows "No query selected." once services have settled with still no usable query', async () => {
    // Pins the case this must NOT paper over: services fetch settled (e.g.
    // an empty service list, so App's default-query effect never fires) and
    // the query is still unset. This is a genuine "nothing to select"
    // conclusion, not a startup gap, so the message must still show.
    at('/');
    render(<SingleView {...PROPS} query="" servicesSettled services={[]} />);

    await waitFor(() => assert.ok(screen.getByText('No query selected.')));
  });
});

describe('SingleView due-navigation gap before the default query lands (FINDING 3)', () => {
  afterEach(() => {
    at('/');
  });

  it('shows the loading indicator, not "No query selected.", once services settle non-empty but the URL still has no query param', async () => {
    // App's default-query effect (App.tsx) is about to write a `query` param
    // — services have arrived and the URL has none yet — but that write is
    // a separate effect this view never sees run (this test renders
    // SingleView in isolation, not App). Before FIX 3, this window read as
    // "profileTypeID empty and servicesLoading is (by now) false", which
    // fell through to the honest-looking but false "No query selected."
    at('/');
    const { container } = render(
      <SingleView
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
    assert.ok(!screen.queryByText('No query selected.'));
  });

  it('does not show the loading indicator when the query param is explicitly empty, even with services settled non-empty', async () => {
    // `?query=` is a real, user-chosen answer (App.tsx's rawQuery !== null
    // distinction) — defaultQueryPending must not treat it as "a write is
    // coming" just because services arrived.
    at('/?query=');
    render(
      <SingleView
        {...PROPS}
        query=""
        servicesSettled
        services={[{ name: 'web', profileTypes: [CPU] }]}
      />,
    );

    await waitFor(() => assert.ok(screen.getByText('No query selected.')));
  });
});

describe('SingleView explicit empty query stays honest through a services refresh (FINDING 1)', () => {
  afterEach(() => {
    at('/');
  });

  it('keeps showing "No query selected." — never the loading placeholder — while a background services refetch pulses servicesLoading', async () => {
    // `?query=` is explicit and settled; a relative range's "now" advances
    // on every navigation/auto-refresh tick (AGENTS.md), which pulses
    // `servicesLoading` true again on each one even though nothing about
    // the conclusion changed. Before FIX 1, `settlingQuery` read
    // `servicesLoading` directly and flickered back to the spinner on every
    // one of those pulses.
    at('/?query=');
    const { container, rerender } = render(
      <SingleView {...PROPS} query="" servicesSettled services={[]} />,
    );
    await waitFor(() => assert.ok(screen.getByText('No query selected.')));
    assert.ok(!container.querySelector('.loading'));

    rerender(
      <SingleView
        {...PROPS}
        query=""
        servicesSettled
        servicesLoading
        services={[]}
      />,
    );
    assert.ok(screen.getByText('No query selected.'));
    assert.ok(!container.querySelector('.loading'));
  });
});
