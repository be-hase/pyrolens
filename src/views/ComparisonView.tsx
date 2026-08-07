import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { FlameGraph } from '@components/FlameGraph';
import { useFlamegraph } from '@hooks/useProfileData';
import { splitQuery } from '../queryLang';
import { ComparisonPane } from './ComparisonPane';
import { useComparisonParams, type PaneParams } from './comparisonParams';

function PaneFlamegraph({
  pane,
  tenantID,
}: {
  pane: PaneParams;
  tenantID?: string;
}) {
  const { flamegraph, error } = useFlamegraph({
    query: pane.query,
    range: pane.range,
    tenantID,
  });
  const { profileTypeID } = splitQuery(pane.query);
  return (
    <>
      {error && <div className="app-error">{error}</div>}
      <FlameGraph data={flamegraph} profileTypeId={profileTypeID} vertical />
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
  range,
  tenantID,
}: ViewProps) {
  const { left, right } = useComparisonParams(query, range);

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
        >
          <PaneFlamegraph pane={left} tenantID={tenantID} />
        </ComparisonPane>
        <ComparisonPane
          title="Comparison"
          pane={right}
          mainRange={range}
          mainFrom={from}
          tenantID={tenantID}
        >
          <PaneFlamegraph pane={right} tenantID={tenantID} />
        </ComparisonPane>
      </div>
    </div>
  );
}
