import { useMemo } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { Panel } from '@components/Panel';
import { Empty } from '@components/core/Empty';
import { profileTypeUnit } from '@api/client';
import { FlameGraph as GrafanaFlameGraph } from '@lib/flamegraph';
import {
  diffFlamebearerToDataFrame,
  grafanaUnit,
} from '@components/flamebearer';
import { useDiffFlamegraph } from '@hooks/useProfileData';
import { useFlameGraphUrlState } from '@hooks/useFlameGraphUrlState';
import { splitQuery } from '../queryLang';
import { ComparisonPane, ErrorBanner } from './ComparisonPane';
import { useComparisonParams } from './comparisonParams';

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

  const { diff, loading, error, retry } = useDiffFlamegraph({
    leftQuery: left.query,
    rightQuery: right.query,
    leftRange: left.range,
    rightRange: right.range,
    tenantID,
  });

  const unit = grafanaUnit(
    profileTypeUnit(splitQuery(left.query).profileTypeID),
  );
  const dataFrame = useMemo(
    () => (diff ? diffFlamebearerToDataFrame(diff, unit) : undefined),
    [diff, unit],
  );

  // No-frames placeholder for when dataFrame is falsy. While loading, the
  // panel's own "Loading…" meta above already says so — see FlameGraph's
  // identical reasoning for rendering nothing rather than a second,
  // redundant message. And no contextual claim while the banner already
  // shows this fetch's error — see FlameGraph's identical gate.
  const diffEmpty = loading ? null : (
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
      />
      <div className="comparison-grid">
        <ComparisonPane
          title="Baseline"
          pane={left}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
        />
        <ComparisonPane
          title="Comparison"
          pane={right}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
        />
      </div>

      {error && <ErrorBanner error={error} retry={retry} />}

      <Panel title="Diff flamegraph" meta={loading ? 'Loading…' : undefined}>
        {dataFrame ? (
          <div className="flamegraph-wrapper">
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
