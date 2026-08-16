import { useMemo } from 'react';
import { Empty } from '@components/core/Empty';
import { profileTypeUnit, type FlamegraphData } from '@api/client';
import { useFlameGraphUrlState } from '@hooks/useFlameGraphUrlState';
import { FlameGraph as GrafanaFlameGraph } from '@lib/flamegraph';
import { flamebearerToDataFrame, grafanaUnit } from './flamebearer';
import './FlameGraph.css';

// Thin wrapper mapping Pyroscope flamebearer data onto the vendored Grafana
// flame graph component. The fgSearch/fgSandwich URL wiring itself lives in
// useFlameGraphUrlState so DiffView's own flame graph can share it instead
// of duplicating the edit-buffer/debounce/write-effect dance.
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

  const { search, onSearchChange, sandwichItem, onSandwichChange } =
    useFlameGraphUrlState();

  return frame ? (
    <div className="flamegraph-wrapper">
      <GrafanaFlameGraph
        data={frame}
        vertical={vertical}
        search={search}
        onSearchChange={onSearchChange}
        sandwichItem={sandwichItem}
        onSandwichChange={onSandwichChange}
      />
    </div>
  ) : (
    <Empty />
  );
}
