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
  servicesSettled: true,
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

describe('DiffView loading placeholder', () => {
  it('shows the loading indicator in the diff flamegraph body while the diff fetch is pending', async () => {
    // A promise that never resolves during this test keeps `diff` loading —
    // the diffEmpty branch (dataFrame is falsy while diff is still null)
    // must render Loading in the panel body, not just the panel meta's own
    // "Loading…" text (which renders regardless and would make a
    // text-content-only assertion pass even against the unfixed `null`).
    // `.loading` is the new component's own class, distinct from
    // `.panel-meta`, so this pins the assertion to the body placeholder.
    diffOf.mockReturnValue(new Promise(() => {}));

    const { container } = render(<DiffView {...PROPS} />);

    await waitFor(() =>
      assert.ok(
        container.querySelector('.loading'),
        'expected the Loading placeholder in the diff flamegraph body while the diff fetch is pending',
      ),
    );
  });

  it('pins the wiring: each pane timeline shows the loading indicator while its own fetch is pending', async () => {
    // A Comparison-pane-level flamegraph check (PaneFlamegraph, in
    // ComparisonView.tsx) is out of scope here — it isn't a file this task
    // may touch and there's no existing view-level harness for it. This
    // covers the equally real regression risk that's actually in scope:
    // ComparisonPane wiring its own `loading` through to the TimeSeries it
    // renders (both Baseline and Comparison panes render one, and DiffView
    // already mounts both). The diff fetch itself resolves normally so only
    // the pane timelines stay pending, isolating what's under test.
    timelineOf.mockReturnValue(new Promise(() => {}));

    const { container } = render(<DiffView {...PROPS} />);

    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        2,
        'expected both pane timelines (Baseline and Comparison) to show the loading indicator',
      ),
    );
  });
});

describe('DiffView startup gap before the default query resolves', () => {
  it('shows the loading indicator in both panes and the diff panel instead of the empty-state text while services have never settled and no query yet', async () => {
    // Mirrors App.tsx: before the services fetch settles, no default query
    // has been written into the URL yet, so query='' and both panes inherit
    // it (see useComparisonParams) — neither side has a profile type, so the
    // diff RPC never runs (useDiffFlamegraph's `active` needs both types),
    // and the diff panel used to fall through to the generic "no profiles
    // matched" message instead of showing this is still a startup gap.
    const { container } = render(
      <DiffView
        {...PROPS}
        query=""
        servicesLoading
        servicesSettled={false}
        services={[]}
      />,
    );

    await waitFor(() =>
      assert.equal(
        container.querySelectorAll('.loading').length,
        3,
        'expected both pane timelines and the diff flamegraph body to show the Loading placeholder',
      ),
    );
    assert.ok(
      !screen.queryByText(
        /No profiles matched this query in the baseline or comparison window/,
      ),
    );
  });
});

describe('DiffView one-sided deep link during a services startup gap (FINDING 2)', () => {
  it('shows the loading indicator, not the mismatch or empty conclusion, when only one pane has a resolved profile type', async () => {
    // Deep link supplies a profile_type on the left pane only; there is no
    // main `query` param, so the right pane inherits the still-unset main
    // query and has no type yet. Before FIX 2, `settlingQuery` required
    // BOTH types to be absent (`!leftType && !rightType`), so this
    // one-sided case fell through past the startup-gap gate while services
    // were still resolving the default query.
    const params = new URLSearchParams();
    params.set('leftQuery', QUERY);
    at(`/?${params.toString()}`);

    const { container } = render(
      <DiffView
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
        'expected the Loading placeholder in the diff flamegraph body',
      ),
    );
    assert.ok(
      !screen.queryByText(
        /Diff needs both panes to query the same profile type/,
      ),
    );
    assert.ok(
      !screen.queryByText(
        /No profiles matched this query in the baseline or comparison window/,
      ),
    );
  });
});

describe('DiffView due-navigation gap before the default query lands (FINDING 3)', () => {
  it('shows the loading indicator instead of the empty conclusion once services settle non-empty but the URL still has no query param', async () => {
    at('/');
    const { container } = render(
      <DiffView
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
      !screen.queryByText(
        /No profiles matched this query in the baseline or comparison window/,
      ),
    );
  });
});
