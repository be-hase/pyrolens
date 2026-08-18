import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { FlameGraph } from '@components/FlameGraph';
import { Button } from '@components/core/Button';
import { useFlamegraph, useTimeline } from '@hooks/useProfileData';
import { parseMaxNodes, type FlamegraphData } from '@api/client';
import { defaultQueryPending, splitQuery } from '../queryLang';
import { navigate, useRoute, useTickNavigation } from '../urlState';
import { ComparisonPane, ErrorBanner } from './ComparisonPane';
import {
  swappedPaneParams,
  useComparisonParams,
  type PaneParams,
} from './comparisonParams';

// Kept local rather than exported from a shared module: react-refresh's
// lint rule requires a component file's exports to be components only, so
// SingleView.tsx duplicates this rather than importing it.
const FLAMEGRAPH_EMPTY_MESSAGE =
  'No profiles matched this query in this range. Recently ingested ' +
  'profiles can take about a minute to become queryable.';

function isLast24h(from: string, until: string): boolean {
  return from === 'now-24h' && until === 'now';
}

function PaneFlamegraph({
  flamegraph,
  loading,
  error,
  retry,
  pane,
  from,
  until,
  queryStartupGap,
}: {
  /**
   * Fetched by the parent (ComparisonView), not in here — the pane's Run
   * button needs to see this fetch's `loading` too (a Run reflects every
   * fetch its commit would supersede: this pane's timeline AND its flame
   * graph), so it is lifted to where both the button and this panel can
   * read the same fetch instead of a second call site duplicating it.
   */
  flamegraph: FlamegraphData;
  loading: boolean;
  error: string | null;
  retry?: () => void;
  pane: PaneParams;
  /** Main view range, not the pane's own brushed sub-range — "Last 24
   * hours" widens the range everything is brushed against. */
  from: string;
  until: string;
  /**
   * Whether the main query hasn't resolved to something real yet — either
   * the services fetch has never settled, or it has and a default-query
   * write is due but hasn't landed in the URL. See ComparisonView's
   * `queryStartupGap` and SingleView's identical `settlingQuery` for the
   * full reasoning; this pane just receives the precomputed result so it
   * doesn't need `services`/the raw `query` param itself.
   */
  queryStartupGap?: boolean;
}) {
  const { profileTypeID } = splitQuery(pane.query);
  // Startup gap: before the main query resolves, an inheriting pane's query
  // is still the unset main query, so `profileTypeID` is empty because
  // there is no query yet — not because nothing matched.
  const settlingQuery = !!queryStartupGap && !profileTypeID;
  // An auto-refresh tick must not visually interrupt (urlState.ts's
  // useTickNavigation doctrine) — suppresses the reload-dim/loading-swap
  // below for a tick-caused reload.
  const tickNav = useTickNavigation();
  return (
    <>
      {error && <ErrorBanner error={error} retry={retry} />}
      <FlameGraph
        data={flamegraph}
        profileTypeId={profileTypeID}
        vertical
        loading={(loading && !tickNav) || settlingQuery}
        // Suppressed while this pane has its own error — see SingleView's
        // identical gate.
        empty={
          error
            ? undefined
            : !profileTypeID
              ? settlingQuery
                ? // Still a startup gap — the `loading` prop above already
                  // swaps this out for the Loading placeholder, but keep the
                  // claim from being wrong even momentarily. See
                  // SingleView's identical gate.
                  undefined
                : // No usable query on this pane means no fetch was ever sent
                  // (see SingleView's identical gate) — asserting "no profiles
                  // matched" and offering "Last 24 hours" would misstate a
                  // query that never ran.
                  { message: 'No query selected.' }
              : {
                  message: FLAMEGRAPH_EMPTY_MESSAGE,
                  action: isLast24h(from, until)
                    ? undefined
                    : {
                        label: 'Last 24 hours',
                        onClick: () =>
                          navigate({
                            set: {
                              from: 'now-24h',
                              until: null,
                              // Widening the main range must also clear the
                              // pane sub-ranges, or a pane stays pinned to
                              // its previously brushed range and the
                              // widening has no visible effect — the same
                              // clear the Tag Explorer's compareRow does
                              // when it lands here.
                              leftFrom: null,
                              leftUntil: null,
                              rightFrom: null,
                              rightUntil: null,
                            },
                          }),
                      },
                }
        }
      />
    </>
  );
}

// Side-by-side comparison. Frames are colored by package name (murmur3 hash),
// so identical frames get identical colors in both panes.
export function ComparisonView({
  services,
  servicesLoading,
  servicesSettled,
  query,
  from,
  until,
  range,
  tenantID,
}: ViewProps) {
  const { left, right } = useComparisonParams(query, range);
  const { params } = useRoute();
  const maxNodes = parseMaxNodes(params.get('maxNodes'));
  // See SingleView's identical `settlingQuery` and queryLang.ts's
  // `defaultQueryPending`: true while the main query hasn't resolved to
  // something real yet, computed once here and handed to both panes rather
  // than each rederiving it from `services`/the raw `query` param.
  const queryStartupGap =
    !servicesSettled || defaultQueryPending(services, params.get('query'));

  // Lifted here (rather than fetched inside ComparisonPane/PaneFlamegraph)
  // so a pane's Run button can reflect BOTH its timeline and its flame
  // graph fetch — the button lives in ComparisonPane, the flame graph fetch
  // used to live entirely inside PaneFlamegraph, and neither could see the
  // other's `loading` without one of them fetching twice.
  const leftTl = useTimeline({ query: left.query, range, tenantID });
  const rightTl = useTimeline({ query: right.query, range, tenantID });
  const leftFg = useFlamegraph({
    query: left.query,
    range: left.range,
    tenantID,
    maxNodes,
  });
  const rightFg = useFlamegraph({
    query: right.query,
    range: right.range,
    tenantID,
    maxNodes,
  });

  return (
    <div className="app-content">
      <ControlsBar
        services={services}
        servicesLoading={servicesLoading}
        query={query}
        from={from}
        until={until}
        range={range}
        showMaxNodes
      />
      {/* Same spot in Comparison and Diff — above the panes, right-aligned —
          so the control is where muscle memory expects it in either view.
          Reuses Panel's small-action-button styling (Panel.css) even though
          this row sits above a panel rather than inside one. */}
      <div className="panel-actions" style={{ justifyContent: 'flex-end' }}>
        <Button
          onClick={() =>
            navigate({
              set: swappedPaneParams(left, right, range, from, until),
            })
          }
        >
          Swap sides
        </Button>
      </div>
      <div className="comparison-grid">
        <ComparisonPane
          title="Baseline"
          pane={left}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
          queryStartupGap={queryStartupGap}
          timeline={leftTl.timeline}
          loading={leftTl.loading}
          error={leftTl.error}
          retry={leftTl.retry}
          extraLoading={leftFg.loading}
        >
          <PaneFlamegraph
            flamegraph={leftFg.flamegraph}
            loading={leftFg.loading}
            error={leftFg.error}
            retry={leftFg.retry}
            pane={left}
            from={from}
            until={until}
            queryStartupGap={queryStartupGap}
          />
        </ComparisonPane>
        <ComparisonPane
          title="Comparison"
          pane={right}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
          queryStartupGap={queryStartupGap}
          timeline={rightTl.timeline}
          loading={rightTl.loading}
          error={rightTl.error}
          retry={rightTl.retry}
          extraLoading={rightFg.loading}
        >
          <PaneFlamegraph
            flamegraph={rightFg.flamegraph}
            loading={rightFg.loading}
            error={rightFg.error}
            retry={rightFg.retry}
            pane={right}
            from={from}
            until={until}
            queryStartupGap={queryStartupGap}
          />
        </ComparisonPane>
      </div>
    </div>
  );
}
