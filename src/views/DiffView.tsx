import { useEffect, useMemo, useState } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { Panel } from '@components/Panel';
import { Empty } from '@components/core/Empty';
import {
  fetchDiffFlamegraph,
  profileTypeUnit,
  type DiffFlamegraphData,
} from '@api/client';
import { FlameGraph as GrafanaFlameGraph } from '@lib/flamegraph';
import {
  diffFlamebearerToDataFrame,
  grafanaUnit,
} from '@components/flamebearer';
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
  range,
  tenantID,
}: ViewProps) {
  const { left, right } = useComparisonParams(query, range);

  const [diff, setDiff] = useState<DiffFlamegraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const leftSplit = splitQuery(left.query);
  const rightSplit = splitQuery(right.query);

  // Derived so an aborted run can't leave the spinner stuck on.
  const active = !!leftSplit.profileTypeID && !!rightSplit.profileTypeID;
  const loading = active && fetching;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function load() {
      setFetching(true);
      try {
        const d = await fetchDiffFlamegraph(
          {
            profileTypeID: leftSplit.profileTypeID,
            labelSelector: leftSplit.labelSelector,
            start: left.range.start,
            end: left.range.end,
          },
          {
            profileTypeID: rightSplit.profileTypeID,
            labelSelector: rightSplit.labelSelector,
            start: right.range.start,
            end: right.range.end,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setDiff(d);
        setError(null);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setFetching(false);
      }
    }
    load();

    return () => controller.abort();
  }, [
    active,
    leftSplit.profileTypeID,
    leftSplit.labelSelector,
    rightSplit.profileTypeID,
    rightSplit.labelSelector,
    left.range.start,
    left.range.end,
    right.range.start,
    right.range.end,
    tenantID,
  ]);

  const unit = grafanaUnit(profileTypeUnit(leftSplit.profileTypeID));
  const dataFrame = useMemo(
    () => (diff ? diffFlamebearerToDataFrame(diff, unit) : undefined),
    [diff, unit],
  );

  return (
    <div className="app-content">
      <ControlsBar services={services} servicesLoading={servicesLoading} />
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
            <GrafanaFlameGraph data={dataFrame} />
          </div>
        ) : (
          <Empty />
        )}
      </Panel>
    </div>
  );
}
