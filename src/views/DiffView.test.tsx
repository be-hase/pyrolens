import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchDiffFlamegraph, fetchTimeline } from '@api/client';
import { navigate } from '../urlState.ts';
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

// The single global Run's tests below need to see exactly what DiffView
// passes to `navigate()` — in particular, that a side never edited is
// omitted from `set` entirely rather than written with its resolved value
// (the absence-inherits invariant, AGENTS.md) and that an all-absent `set`
// still fires. Wrapping the real implementation (not replacing it) keeps
// every other test in this file exercising real navigation/URL behavior
// unchanged.
vi.mock('../urlState.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlState.ts')>();
  return {
    ...actual,
    navigate: vi.fn(actual.navigate),
  };
});

// jsdom has no ResizeObserver (see AGENTS.md's "Verifying a change"); the
// pane timelines observe their container to size the canvas backing store.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The reload-dim tests below need the diff panel's dataFrame-present branch
// to render without throwing — the real vendored FlameGraph needs a canvas
// 2D context jsdom doesn't provide (see FlameGraph.test.tsx's identical
// stub). Every other test in this file only ever resolves empty diff data,
// so this has no effect on them.
vi.mock('@lib/flamegraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/flamegraph')>();
  return {
    ...actual,
    FlameGraph: () => <div data-testid="grafana-flamegraph-stub" />,
  };
});

const diffOf = vi.mocked(fetchDiffFlamegraph);
const timelineOf = vi.mocked(fetchTimeline);
const navigateSpy = vi.mocked(navigate);

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
  // A tick navigation in one test must not leak its marker into the next —
  // a plain navigate() carries no tick option and settles it back to false
  // (mirrors SingleView.test.tsx's identical reset).
  navigate({ set: {} });
});

describe('DiffView ControlsBar', () => {
  it('renders the Max nodes slider', () => {
    render(<DiffView {...PROPS} />);
    assert.ok(screen.getByRole('slider', { name: 'Max nodes' }));
    // The accessible name now comes from this same visible label
    // (aria-labelledby, see MaxNodesControl.tsx) rather than a separate
    // aria-label string — a single source for both.
    assert.ok(screen.getByText('Max nodes'));
  });
});

describe('DiffView profile-type mismatch', () => {
  it('does not request a diff and explains the mismatch when panes name different profile types', async () => {
    const params = new URLSearchParams();
    params.set('rightQuery', `{service_name="api", profile_type="${ALLOC}"}`);
    at(`/?${params.toString()}`);

    render(<DiffView {...PROPS} />);

    // Both pane timelines still fetch independently (DiffView lifts them
    // itself now) — it is only the Diff RPC, which assumes matching types,
    // that must be withheld.
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

describe('DiffView reload dim', () => {
  // Diff wire shape: one string per bar field, seven per bar (gap/width/own
  // for each side, then the name index) — see flamebearer.test.ts's `diff`
  // helper. Left side carries the whole bar, right side zeroed.
  const ONE_FRAME = {
    names: ['root'],
    levels: [{ values: ['0', '100', '50', '0', '0', '0', '0'] }],
  };

  it('dims the diff flamegraph wrapper while a refetch is in flight over frames already on screen', async () => {
    diffOf.mockResolvedValueOnce(ONE_FRAME);
    const { container, rerender } = render(<DiffView {...PROPS} />);
    await waitFor(() =>
      assert.ok(container.querySelector('.flamegraph-wrapper')),
    );

    // A `range` prop change stands in for whatever re-fires the diff fetch
    // under the same queries while the previous frames are still on
    // screen — this test performs no navigate() call at all, so urlState's
    // tick marker stays at its default (cleared by the file's top-level
    // afterEach), pinning the USER-navigation baseline: no marker, so the
    // reload dims. See the "tick navigation" test below for the suppressed
    // case. Hold this one pending so `loading` stays true with `diff` still
    // non-null.
    diffOf.mockReturnValue(new Promise(() => {}));
    rerender(
      <DiffView {...PROPS} range={{ start: 2_000_000, end: 5_600_000 }} />,
    );
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 2));

    const wrapper = container.querySelector('.flamegraph-wrapper');
    assert.ok(wrapper, 'expected the flamegraph-wrapper to still render');
    assert.ok(
      wrapper.classList.contains('reload-dim') &&
        wrapper.classList.contains('active'),
      'expected the wrapper to carry the reload-dim active class while a refetch is in flight over existing frames',
    );
  });

  it('does not dim the diff flamegraph wrapper when the refetch is caused by a tick navigation — the panel meta still says "Loading…"', async () => {
    // An auto-refresh tick is background activity (urlState.ts's
    // useTickNavigation doctrine) — must not visually interrupt what's on
    // screen. Same setup as the test above, but the pending refetch is
    // marked as tick-caused (what RefreshPicker's own interval firing —
    // or its visibility-return refresh — does) before it starts.
    diffOf.mockResolvedValueOnce(ONE_FRAME);
    const { container, rerender } = render(<DiffView {...PROPS} />);
    await waitFor(() =>
      assert.ok(container.querySelector('.flamegraph-wrapper')),
    );

    diffOf.mockReturnValue(new Promise(() => {}));
    act(() => navigate({ set: {}, tick: true }));
    rerender(
      <DiffView {...PROPS} range={{ start: 2_000_000, end: 5_600_000 }} />,
    );
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 2));

    const wrapper = container.querySelector('.flamegraph-wrapper');
    assert.ok(wrapper, 'expected the flamegraph-wrapper to still render');
    assert.ok(
      !wrapper.classList.contains('active'),
      'a tick-caused reload must not dim the diff flame graph',
    );

    const panel = screen
      .getByText('Diff flamegraph')
      .closest<HTMLElement>('.panel')!;
    assert.ok(
      within(panel).getByText('Loading…'),
      'the panel meta must keep announcing the reload during a tick',
    );
    assert.ok(
      panel.querySelector('.loading-meta .loading-spin'),
      'expected the meta spinner (LoadingMeta) next to the text',
    );
  });

  it('does not dim the diff flamegraph wrapper once the fetch has settled', async () => {
    diffOf.mockResolvedValue(ONE_FRAME);
    const { container } = render(<DiffView {...PROPS} />);
    await waitFor(() =>
      assert.ok(container.querySelector('.flamegraph-wrapper')),
    );

    const wrapper = container.querySelector('.flamegraph-wrapper');
    assert.ok(wrapper, 'expected the flamegraph-wrapper to render');
    assert.ok(
      !wrapper.classList.contains('active'),
      'the wrapper must not carry the active dim class once the fetch has settled',
    );
  });
});

describe('DiffView: a tick-caused reload over a settled-empty diff must not swap the Empty message for the Loading placeholder', () => {
  it('via tick: the "No profiles matched" message stays', async () => {
    // The default mock (top-level beforeEach) already resolves an empty
    // diff, so the first render settles honestly empty.
    const { rerender } = render(<DiffView {...PROPS} />);
    const panel = () =>
      screen.getByText('Diff flamegraph').closest<HTMLElement>('.panel')!;
    await waitFor(() =>
      assert.ok(
        within(panel()).getByText(
          /No profiles matched this query in the baseline or comparison window/,
        ),
      ),
    );

    diffOf.mockReturnValueOnce(new Promise(() => {}));
    act(() => navigate({ set: {}, tick: true }));
    rerender(
      <DiffView {...PROPS} range={{ start: 2_000_000, end: 5_600_000 }} />,
    );
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 2));

    assert.ok(
      within(panel()).getByText(
        /No profiles matched this query in the baseline or comparison window/,
      ),
      'a tick reload over a settled-empty diff must keep the honest Empty message',
    );
    assert.ok(
      !panel().querySelector('.loading'),
      'must not swap the Empty message for the Loading placeholder on a tick',
    );
    assert.ok(within(panel()).getByText('Loading…'));
  });

  it('via a user navigation: the Loading placeholder replaces the Empty message, as today', async () => {
    const { rerender } = render(<DiffView {...PROPS} />);
    const panel = () =>
      screen.getByText('Diff flamegraph').closest<HTMLElement>('.panel')!;
    await waitFor(() =>
      assert.ok(
        within(panel()).getByText(
          /No profiles matched this query in the baseline or comparison window/,
        ),
      ),
    );

    diffOf.mockReturnValueOnce(new Promise(() => {}));
    rerender(
      <DiffView {...PROPS} range={{ start: 2_000_000, end: 5_600_000 }} />,
    );
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 2));

    await waitFor(() =>
      assert.ok(
        panel().querySelector('.loading'),
        'a user-caused reload must still swap Empty for the Loading placeholder',
      ),
    );
    assert.ok(
      !within(panel()).queryByText(
        /No profiles matched this query in the baseline or comparison window/,
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

// The diff flame graph is one joint query over both panes, so per-pane Run
// buttons are misleading here — a single Run above the panes replaces them
// and commits both drafts in one navigation. See ComparisonView's identical
// per-pane Run, unchanged there.
describe('DiffView: a single Run button replaces the per-pane ones', () => {
  it("hides each pane's own Run button and renders exactly one global Run", async () => {
    render(<DiffView {...PROPS} />);
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));

    assert.equal(
      screen.queryAllByRole('button', { name: /^Run$/ }).length,
      1,
      'expected exactly one Run button on Diff — the global one above the ' +
        'panes — with both per-pane Run buttons hidden',
    );
  });
});

describe('DiffView: Enter in a pane still commits that pane alone', () => {
  it('pressing Enter in the Baseline query bar writes leftQuery only, unaffected by the global Run', async () => {
    render(<DiffView {...PROPS} />);
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));

    const baselinePanel = screen
      .getByText('Baseline')
      .closest<HTMLElement>('.panel')!;
    const input = within(baselinePanel).getByRole(
      'combobox',
    ) as HTMLInputElement;
    const edited = `{service_name="checkout", profile_type="${CPU}"}`;
    fireEvent.change(input, {
      target: { value: edited, selectionStart: edited.length },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('leftQuery'),
        edited,
      ),
    );
    assert.equal(
      new URLSearchParams(window.location.search).has('rightQuery'),
      false,
    );
  });
});

describe('DiffView: the single global Run', () => {
  it("commits only the edited side in one navigation — the untouched side's inherited value is never materialized — and refetches once", async () => {
    render(<DiffView {...PROPS} />);
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));
    const diffCallsBefore = diffOf.mock.calls.length;
    const timelineCallsBefore = timelineOf.mock.calls.length;

    const baselinePanel = screen
      .getByText('Baseline')
      .closest<HTMLElement>('.panel')!;
    const input = within(baselinePanel).getByRole(
      'combobox',
    ) as HTMLInputElement;
    const edited = `{service_name="checkout", profile_type="${CPU}"}`;
    // Fill the draft but do NOT press Enter — only the global Run should
    // commit it.
    fireEvent.change(input, {
      target: { value: edited, selectionStart: edited.length },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get('leftQuery'),
        edited,
      ),
    );
    assert.equal(
      new URLSearchParams(window.location.search).has('rightQuery'),
      false,
      'the right pane was never edited — its inherited value must not be ' +
        'written as an override',
    );
    assert.equal(navigateSpy.mock.calls.length, 1);
    assert.deepEqual(navigateSpy.mock.calls[0][0], {
      set: { leftQuery: edited },
    });

    // Exactly one refetch each: only the left pane's query changed, so only
    // its timeline refires; the diff fetch refires once because it depends
    // on both queries.
    await waitFor(() =>
      assert.equal(diffOf.mock.calls.length, diffCallsBefore + 1),
    );
    await waitFor(() =>
      assert.equal(timelineOf.mock.calls.length, timelineCallsBefore + 1),
    );
  });

  it('still navigates with an empty set — the write that makes Run a real refresh — when neither draft was touched', async () => {
    render(<DiffView {...PROPS} />);
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => assert.equal(navigateSpy.mock.calls.length, 1));
    assert.deepEqual(navigateSpy.mock.calls[0][0], { set: {} });
    assert.equal(
      new URLSearchParams(window.location.search).has('leftQuery'),
      false,
    );
    assert.equal(
      new URLSearchParams(window.location.search).has('rightQuery'),
      false,
    );
  });

  it('stays busy while the diff fetch is pending', async () => {
    diffOf.mockReturnValue(new Promise(() => {}));
    render(<DiffView {...PROPS} />);
    await waitFor(() => assert.equal(diffOf.mock.calls.length, 1));

    const runButton = screen.getByRole('button', { name: /^Run$/ });
    assert.equal((runButton as HTMLButtonElement).disabled, true);
    assert.equal(runButton.getAttribute('aria-busy'), 'true');
  });
});
