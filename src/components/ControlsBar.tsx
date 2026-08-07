import { CascadeSelect } from '@components/core/CascadeSelect';
import { TimeRangePicker } from '@components/TimeRangePicker';
import { type Service, profileTypeLabel, sortProfileTypes } from '@api/client';
import { buildQuery, parseQuery } from '../queryLang';
import { navigate, useRoute } from '../urlState';
import './ControlsBar.css';

// Service / profile-type picker plus the main time range picker. Both write
// straight to URL params (`query`, `from`, `until`).
export function ControlsBar({
  services,
  servicesLoading,
  children,
}: {
  services: Service[];
  servicesLoading: boolean;
  children?: React.ReactNode;
}) {
  const { params } = useRoute();
  const query = params.get('query') ?? '';
  const from = params.get('from') ?? 'now-1h';
  const until = params.get('until') ?? 'now';
  const parsed = parseQuery(query);

  return (
    <div className="controls-bar">
      <CascadeSelect
        groups={services.map((s) => ({
          label: s.name,
          value: s.name,
          items: sortProfileTypes(s.profileTypes).map((pt) =>
            typeof pt === 'string'
              ? { label: profileTypeLabel(pt), value: pt }
              : pt,
          ),
        }))}
        groupLabel="Service"
        itemLabel="Profile Type"
        value={{
          group: parsed?.service ?? '',
          item: parsed?.profileType ?? '',
        }}
        onChange={(g, i) => navigate({ set: { query: buildQuery(g, i) } })}
        loading={servicesLoading}
      />
      <TimeRangePicker from={from} until={until} />
      {children}
    </div>
  );
}
