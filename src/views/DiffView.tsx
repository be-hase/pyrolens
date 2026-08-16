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
import { ComparisonPane } from './ComparisonPane';
import { useComparisonParams } from './comparisonParams';

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

  const { diff, loading, error } = useDiffFlamegraph({
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

      {error && <div className="app-error">{error}</div>}

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
          <Empty />
        )}
      </Panel>
    </div>
  );
}
