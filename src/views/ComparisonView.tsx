import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { FlameGraph } from '@components/FlameGraph';
import { Button } from '@components/core/Button';
import { useFlamegraph } from '@hooks/useProfileData';
import { splitQuery } from '../queryLang';
import { navigate } from '../urlState';
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
  pane,
  tenantID,
  from,
  until,
}: {
  pane: PaneParams;
  tenantID?: string;
  /** Main view range, not the pane's own brushed sub-range — "Last 24
   * hours" widens the range everything is brushed against. */
  from: string;
  until: string;
}) {
  const { flamegraph, loading, error, retry } = useFlamegraph({
    query: pane.query,
    range: pane.range,
    tenantID,
  });
  const { profileTypeID } = splitQuery(pane.query);
  return (
    <>
      {error && <ErrorBanner error={error} retry={retry} />}
      <FlameGraph
        data={flamegraph}
        profileTypeId={profileTypeID}
        vertical
        loading={loading}
        // Suppressed while this pane has its own error — see SingleView's
        // identical gate.
        empty={
          error
            ? undefined
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
                            // pane sub-ranges, or a pane stays pinned to its
                            // previously brushed range and the widening has
                            // no visible effect — the same clear the Tag
                            // Explorer's compareRow does when it lands here.
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
  query,
  from,
  until,
  range,
  tenantID,
}: ViewProps) {
  const { left, right } = useComparisonParams(query, range);

  return (
    <div className="app-content">
      <ControlsBar
        services={services}
        servicesLoading={servicesLoading}
        query={query}
        from={from}
        until={until}
        range={range}
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
        >
          <PaneFlamegraph
            pane={left}
            tenantID={tenantID}
            from={from}
            until={until}
          />
        </ComparisonPane>
        <ComparisonPane
          title="Comparison"
          pane={right}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
        >
          <PaneFlamegraph
            pane={right}
            tenantID={tenantID}
            from={from}
            until={until}
          />
        </ComparisonPane>
      </div>
    </div>
  );
}
