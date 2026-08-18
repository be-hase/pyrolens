import { act, render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchFlamegraph, fetchTimeline } from '@api/client';
import { navigate } from '../urlState.ts';
import { ComparisonView } from './ComparisonView.tsx';
import type { ViewProps } from '../App.tsx';

// Real profileTypeLabel/profileTypeUnit/etc. are kept — only the two network
// calls this view (and the ComparisonPane timelines it renders) actually
// drive are replaced. See SingleView.test.tsx's identical reasoning.
vi.mock('@api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@api/client')>();
  return {
    ...actual,
    fetchFlamegraph: vi.fn(),
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

// The reload-dim test below needs the flame graph's data-present branch to
// render without throwing — the real vendored FlameGraph needs a canvas 2D
// context jsdom doesn't provide (see DiffView.test.tsx's identical stub).
// Every other test in this file only ever resolves an empty flamegraph, so
// this has no effect on them.
vi.mock('@lib/flamegraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/flamegraph')>();
  return {
    ...actual,
    FlameGraph: () => <div data-testid="grafana-flamegraph-stub" />,
  };
});

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

const at = (url: string) => window.history.replaceState(null, '', url);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  timelineOf.mockResolvedValue([]);
  flamegraphOf.mockResolvedValue({ names: [], levels: [] });
});

afterEach(() => {
  at('/');
});

describe('ComparisonView ControlsBar', () => {
  it('renders the Max nodes slider', () => {
    render(<ComparisonView {...PROPS} />);
    assert.ok(screen.getByRole('slider', { name: 'Max nodes' }));
    // The accessible name now comes from this same visible label
    // (aria-labelledby, see MaxNodesControl.tsx) rather than a separate
    // aria-label string — a single source for both.
    assert.ok(screen.getByText('Max nodes'));
  });
});

describe('ComparisonView startup gap before the default query resolves', () => {
  it('shows the loading indicator in each pane instead of "No query selected." while services have never settled', async () => {
    // Mirrors App.tsx: before the services fetch settles, no default query
    // has been written into the URL yet, so query='' and both panes inherit
    // it (see useComparisonParams) — neither pane has a profile type, but
    // that is a startup gap, not two panes that matched nothing.
    const { container } = render(
      <ComparisonView
        {...PROPS}
        query=""
        servicesSettled={false}
        services={[]}
      />,
    );

    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        4,
        "expected both panes' timelines and flame graphs to show the Loading placeholder while services resolve the default query",
      ),
    );
    assert.ok(!screen.queryByText('No query selected.'));
  });

  it('shows "No query selected." in each pane once services have settled with still no usable query', async () => {
    // Pins the case this must NOT paper over: services fetch settled (e.g.
    // an empty service list, so App's default-query effect never fires) and
    // the query is still unset. Genuine "nothing to select", not a startup
    // gap, so the message must still show for both panes.
    render(
      <ComparisonView {...PROPS} query="" servicesSettled services={[]} />,
    );

    await waitFor(() =>
      assert.equal(screen.getAllByText('No query selected.').length, 2),
    );
  });
});

describe('ComparisonView due-navigation gap before the default query lands (FINDING 3)', () => {
  it('shows the loading indicator in each pane instead of "No query selected." once services settle non-empty but the URL still has no query param', async () => {
    const { container } = render(
      <ComparisonView
        {...PROPS}
        query=""
        servicesSettled
        services={[{ name: 'web', profileTypes: [CPU] }]}
      />,
    );

    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        4,
        "expected both panes' timelines and flame graphs to show the Loading placeholder while the default-query write is due",
      ),
    );
    assert.ok(!screen.queryByText('No query selected.'));
  });
});

describe('ComparisonView explicit empty query stays honest through a services refresh (FINDING 1)', () => {
  it('keeps showing "No query selected." in each pane — never the loading placeholder — while a background services refetch pulses servicesLoading', async () => {
    at('/?query=');
    const { container, rerender } = render(
      <ComparisonView {...PROPS} query="" servicesSettled services={[]} />,
    );
    await waitFor(() =>
      assert.equal(screen.getAllByText('No query selected.').length, 2),
    );
    assert.ok(!container.querySelector('.loading'));

    rerender(
      <ComparisonView
        {...PROPS}
        query=""
        servicesSettled
        servicesLoading
        services={[]}
      />,
    );
    assert.equal(screen.getAllByText('No query selected.').length, 2);
    assert.ok(!container.querySelector('.loading'));
  });
});

describe("ComparisonView: a tick-caused reload must not dim a pane's flame graph", () => {
  // Minimal single flame graph: one root bar (gap 0, width 100, own 50,
  // name index 0) — enough for flamebearerToDataFrame to return a truthy
  // frame. See FlameGraph.test.tsx's identical ONE_FRAME.
  const ONE_FRAME = { names: ['root'], levels: [[0, 100, 50, 0]] };

  afterEach(() => {
    at('/');
    // A tick navigation in one test must not leak its marker into the next
    // (mirrors SingleView.test.tsx's identical reset).
    navigate({ set: {} });
  });

  it('via tick: both panes keep full opacity while the reload is in flight', async () => {
    flamegraphOf.mockResolvedValue(ONE_FRAME);
    const { container, rerender } = render(<ComparisonView {...PROPS} />);
    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.flamegraph-wrapper').length,
        2,
        'expected both panes to have settled with frames on screen',
      ),
    );
    assert.equal(container.querySelectorAll('.reload-dim.active').length, 0);

    // Hold the next round of fetches pending — a reload in flight over the
    // frames already on screen — and mark it tick-caused first.
    flamegraphOf.mockReturnValue(new Promise(() => {}));
    act(() => navigate({ set: {}, tick: true }));
    rerender(
      <ComparisonView
        {...PROPS}
        range={{ start: 2_000_000, end: 5_600_000 }}
      />,
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 4));

    assert.equal(
      container.querySelectorAll('.reload-dim.active').length,
      0,
      "a tick-caused reload must not dim either pane's flame graph",
    );
  });

  it('via a user navigation: the reload still dims the panes, as today', async () => {
    flamegraphOf.mockResolvedValue(ONE_FRAME);
    const { container, rerender } = render(<ComparisonView {...PROPS} />);
    await waitFor(() =>
      assert.equal(container.querySelectorAll('.flamegraph-wrapper').length, 2),
    );

    flamegraphOf.mockReturnValue(new Promise(() => {}));
    // No tick marker — a `range` change with no tick is what a Run press,
    // a param edit, or Back/Forward looks like from the view's perspective.
    rerender(
      <ComparisonView
        {...PROPS}
        range={{ start: 2_000_000, end: 5_600_000 }}
      />,
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 4));

    await waitFor(() =>
      assert.ok(
        container.querySelectorAll('.reload-dim.active').length > 0,
        'a user-caused reload must still dim the pane flame graphs',
      ),
    );
  });
});
