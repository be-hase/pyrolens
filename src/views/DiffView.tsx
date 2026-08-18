import { useMemo } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { Panel } from '@components/Panel';
import { Button } from '@components/core/Button';
import { Empty } from '@components/core/Empty';
import { Loading } from '@components/core/Loading';
import { parseMaxNodes, profileTypeUnit } from '@api/client';
import { FlameGraph as GrafanaFlameGraph } from '@lib/flamegraph';
import {
  diffFlamebearerToDataFrame,
  grafanaUnit,
} from '@components/flamebearer';
import { useDiffFlamegraph } from '@hooks/useProfileData';
import { useFlameGraphUrlState } from '@hooks/useFlameGraphUrlState';
import { defaultQueryPending, splitQuery } from '../queryLang';
import { navigate, useRoute } from '../urlState';
import { ComparisonPane, ErrorBanner } from './ComparisonPane';
import { swappedPaneParams, useComparisonParams } from './comparisonParams';

// Adapted from FLAMEGRAPH_EMPTY_MESSAGE (SingleView.tsx / ComparisonView.tsx):
// a diff has two windows, so either one — not "this range" — could be why
// there is nothing to compare.
const DIFF_EMPTY_MESSAGE =
  'No profiles matched this query in the baseline or comparison window. ' +
  'Recently ingested profiles can take about a minute to become queryable.';

// Differential flame graph between the Baseline and Comparison selections.
// Green = less time than baseline, red = more (share-of-total normalized).
export function DiffView({
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
  // Diff's flame graph shares the same fgSearch/fgSandwich URL params as
  // Single and Comparison — the container used to be rendered uncontrolled
  // here, so `/diff?fgSearch=alloc` silently did nothing even though README
  // documents the params as global.
  const { search, onSearchChange, sandwichItem, onSandwichChange } =
    useFlameGraphUrlState();
  const { params } = useRoute();
  const maxNodes = parseMaxNodes(params.get('maxNodes'));

  const { diff, loading, error, retry } = useDiffFlamegraph({
    leftQuery: left.query,
    rightQuery: right.query,
    leftRange: left.range,
    rightRange: right.range,
    tenantID,
    maxNodes,
  });

  const leftType = splitQuery(left.query).profileTypeID;
  const rightType = splitQuery(right.query).profileTypeID;
  // The upstream Diff RPC assumes both sides sample the same profile type;
  // useDiffFlamegraph refuses to fetch when they differ (see its comment),
  // so `diff` stays null and this must explain why nothing rendered instead
  // of falling through to the generic "no profiles matched" placeholder,
  // which would misstate a request that was never sent as an empty result.
  const typeMismatch = !!leftType && !!rightType && leftType !== rightType;
  // Startup gap: before the main query resolves, both panes inherit it
  // while unset (see useComparisonParams) — so a side with no profile type
  // may just be waiting for that, not have matched nothing.
  // `queryStartupGap` covers both windows (see ComparisonView's identical
  // flag / queryLang.ts's `defaultQueryPending`): the services fetch never
  // having settled, and it having settled with a default-query write due
  // but not yet landed in the URL. Deliberately `!leftType || !rightType`,
  // not `&&` — a one-sided deep link (only `leftQuery` set, no main `query`)
  // has one type present and one still pending during startup, and `&&`
  // would let the false "no profiles matched"/mismatch conclusion through
  // for that case. The mismatch path above still requires *both* types
  // present, so it is unaffected.
  const queryStartupGap =
    !servicesSettled || defaultQueryPending(services, params.get('query'));
  const settlingQuery = queryStartupGap && (!leftType || !rightType);
  const diffLoading = loading || settlingQuery;

  const unit = grafanaUnit(profileTypeUnit(leftType));
  const dataFrame = useMemo(
    () => (diff ? diffFlamebearerToDataFrame(diff, unit) : undefined),
    [diff, unit],
  );

  // No-frames placeholder for when dataFrame is falsy. While loading, this
  // renders Loading rather than nothing — see FlameGraph's identical
  // reasoning: the panel's own "Loading…" meta is easy to miss, and this is
  // the only flame graph panel in the app whose loading state has no
  // sibling flame graph on screen to lean on. No contextual claim while the
  // banner already shows this fetch's error — see FlameGraph's identical
  // gate.
  const diffEmpty = diffLoading ? (
    <Loading />
  ) : typeMismatch ? (
    <Empty
      message={
        `Baseline queries profile type "${leftType}" and Comparison ` +
        `queries "${rightType}". Diff needs both panes to query the same ` +
        'profile type.'
      }
      action={{
        label: 'Match Comparison to Baseline',
        // Write left's raw override, not its resolved query — left.query is
        // leftQuery ?? mainQuery, so when left has no override this would
        // materialize the main query into rightQuery and permanently detach
        // the right pane from later main-query edits. left.queryOverride is
        // null when left inherits, and navigate's `set` deletes a param on
        // null, so the right pane goes back to inheriting too; when left is
        // overridden, the right pane picks up that same override string.
        onClick: () => navigate({ set: { rightQuery: left.queryOverride } }),
      }}
    />
  ) : (
    <Empty message={error ? undefined : DIFF_EMPTY_MESSAGE} />
  );

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
        />
        <ComparisonPane
          title="Comparison"
          pane={right}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
          queryStartupGap={queryStartupGap}
        />
      </div>

      {error && <ErrorBanner error={error} retry={retry} />}

      <Panel
        title="Diff flamegraph"
        meta={diffLoading ? 'Loading…' : undefined}
      >
        {dataFrame ? (
          <div
            className={
              // Dims the stale diff flame graph while a refresh is in
              // flight over frames already on screen — the complement of
              // diffEmpty's Loading branch above, which only applies when
              // there's no dataFrame yet. See Loading.css for the class.
              diffLoading
                ? 'flamegraph-wrapper reload-dim active'
                : 'flamegraph-wrapper reload-dim'
            }
          >
            <GrafanaFlameGraph
              data={dataFrame}
              search={search}
              onSearchChange={onSearchChange}
              sandwichItem={sandwichItem}
              onSandwichChange={onSandwichChange}
            />
          </div>
        ) : (
          diffEmpty
        )}
      </Panel>
    </div>
  );
}
