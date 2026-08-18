import { render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchFlamegraph, fetchTimeline } from '@api/client';
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
