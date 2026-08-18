import { useMemo } from 'react';
import { CascadeSelect } from '@components/core/CascadeSelect';
import { MaxNodesControl } from '@components/MaxNodesControl';
import { RefreshPicker } from '@components/RefreshPicker';
import { TimeRangePicker } from '@components/TimeRangePicker';
import { type Service, profileTypeLabel, sortProfileTypes } from '@api/client';
import { buildQuery, parseQuery } from '../queryLang';
import type { TimeRange } from '../time';
import { navigate } from '../urlState';
import './ControlsBar.css';

// Service / profile-type picker plus the main time range picker. Both write
// straight to URL params (`query`, `from`, `until`); the current values come
// in as props because App already resolved them — re-reading the URL here
// meant a second copy of the defaults that could drift from App's. maxNodes
// is different: nothing resolves it centrally (each flame-graph view already
// reads it straight off the URL via parseMaxNodes, see SingleView.tsx), so
// MaxNodesControl reads it itself the same way rather than taking it as a
// prop nobody else needed to thread through.
export function ControlsBar({
  services,
  servicesLoading,
  query,
  from,
  until,
  range,
  showMaxNodes,
}: {
  services: Service[];
  servicesLoading: boolean;
  query: string;
  from: string;
  until: string;
  range: TimeRange;
  /** Renders the Max nodes slider — only the views with a flame graph
   * (Single, Comparison, Diff) opt in; Tag Explorer has none. */
  showMaxNodes?: boolean;
}) {
  const parsed = parseQuery(query);

  // Rebuilt only when the service list changes: every keystroke in a query
  // bar re-renders this, and the per-service sort is not free.
  const groups = useMemo(
    () =>
      services.map((s) => ({
        label: s.name,
        value: s.name,
        items: sortProfileTypes(s.profileTypes).map((pt) => ({
          label: profileTypeLabel(pt),
          value: pt,
        })),
      })),
    [services],
  );

  return (
    <div className="controls-bar">
      <CascadeSelect
        groups={groups}
        groupLabel="Service"
        itemLabel="Profile Type"
        value={{
          group: parsed?.service ?? '',
          item: parsed?.profileType ?? '',
        }}
        onChange={(g, i) => navigate({ set: { query: buildQuery(g, i) } })}
        loading={servicesLoading}
      />
      <TimeRangePicker from={from} until={until} range={range} />
      <RefreshPicker from={from} until={until} />
      {showMaxNodes && <MaxNodesControl />}
    </div>
  );
}
