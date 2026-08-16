import { useMemo } from 'react';
import { Empty, type EmptyAction } from '@components/core/Empty';
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
  loading,
  empty,
}: {
  data: FlamegraphData;
  profileTypeId: string;
  vertical?: boolean;
  /**
   * Whether the fetch behind `data` is still in flight. No frames during a
   * load is not evidence of anything yet, so `empty`'s contextual message
   * and action must not render while this is true — a stated conclusion
   * ("no profiles matched") would be false for the entire first fetch, and
   * its action (e.g. "Last 24 hours") could abort a request that was about
   * to succeed.
   */
  loading?: boolean;
  /**
   * Message/action for the no-frames placeholder. The action is left to the
   * caller (e.g. "Last 24 hours") since only the view knows what URL params
   * would actually widen the query. Callers also omit this while their own
   * error is showing, for the same reason `loading` suppresses it here.
   */
  empty?: { message?: string; action?: EmptyAction };
}) {
  const unit = grafanaUnit(profileTypeUnit(profileTypeId));
  const frame = useMemo(() => flamebearerToDataFrame(data, unit), [data, unit]);

  const { search, onSearchChange, sandwichItem, onSandwichChange } =
    useFlameGraphUrlState();

  if (frame) {
    return (
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
    );
  }

  // The panel's own "Loading…" meta already says a fetch is in flight;
  // rendering the neutral placeholder too would just be a second, redundant
  // message, so this renders nothing rather than a default Empty.
  if (loading) return null;

  return <Empty message={empty?.message} action={empty?.action} />;
}
