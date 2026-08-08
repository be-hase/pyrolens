import { useMemo } from 'react';
import { CascadeSelect } from '@components/core/CascadeSelect';
import { TimeRangePicker } from '@components/TimeRangePicker';
import { type Service, profileTypeLabel, sortProfileTypes } from '@api/client';
import { buildQuery, parseQuery } from '../queryLang';
import type { TimeRange } from '../time';
import { navigate } from '../urlState';
import './ControlsBar.css';

// Service / profile-type picker plus the main time range picker. Both write
// straight to URL params (`query`, `from`, `until`); the current values come
// in as props because App already resolved them — re-reading the URL here
// meant a second copy of the defaults that could drift from App's.
export function ControlsBar({
  services,
  servicesLoading,
  query,
  from,
  until,
  range,
}: {
  services: Service[];
  servicesLoading: boolean;
  query: string;
  from: string;
  until: string;
  range: TimeRange;
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
    </div>
  );
}
