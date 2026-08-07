import { useMemo } from 'react';
import { Empty } from '@components/core/Empty';
import { profileTypeUnit, type FlamegraphData } from '@api/client';
import { FlameGraph as GrafanaFlameGraph } from '@lib/flamegraph';
import { flamebearerToDataFrame, grafanaUnit } from './flamebearer';
import './FlameGraph.css';

// Thin wrapper mapping Pyroscope flamebearer data onto the vendored Grafana
// flame graph component.
export function FlameGraph({
  data,
  profileTypeId,
  vertical,
}: {
  data: FlamegraphData;
  profileTypeId: string;
  vertical?: boolean;
}) {
  const unit = grafanaUnit(profileTypeUnit(profileTypeId));
  const frame = useMemo(() => flamebearerToDataFrame(data, unit), [data, unit]);

  return frame ? (
    <div className="flamegraph-wrapper">
      <GrafanaFlameGraph data={frame} vertical={vertical} />
    </div>
  ) : (
    <Empty />
  );
}
