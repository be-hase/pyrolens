import { useState } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { FlameGraph } from '@components/FlameGraph';
import { Panel } from '@components/Panel';
import { QueryBar } from '@components/QueryBar';
import { TimeSeries } from '@components/TimeSeries';
import { useFlamegraph, useTimeline } from '@hooks/useProfileData';
import { profileTypeLabel } from '@api/client';
import { parseQuery, splitQuery } from '../queryLang';
import { formatRangeLabel } from '../time';
import { navigate } from '../urlState';

export function SingleView({
  services,
  servicesLoading,
  query,
  from,
  until,
  range,
  tenantID,
}: ViewProps) {
  const fg = useFlamegraph({ query, range, tenantID });
  const tl = useTimeline({ query, range, tenantID });
  const error = fg.error ?? tl.error;
  const { profileTypeID } = splitQuery(query);
  const parsed = parseQuery(query);

  // Local edit buffer for the query bar; the URL only changes on Run. The
  // buffer resets whenever the URL's query changes (render-time adjustment,
  // per https://react.dev/learn/you-might-not-need-an-effect).
  const [draft, setDraft] = useState<string | null>(null);
  const [prevQuery, setPrevQuery] = useState(query);
  if (prevQuery !== query) {
    setPrevQuery(query);
    setDraft(null);
  }

  return (
    <div className="app-content">
      <ControlsBar services={services} servicesLoading={servicesLoading} />

      <QueryBar
        query={draft ?? query}
        onQueryChange={setDraft}
        onRun={(q) => navigate({ set: { query: q } })}
        start={range.start}
        end={range.end}
        tenantID={tenantID}
        loading={fg.loading || tl.loading}
      />

      {error && <div className="app-error">{error}</div>}

      <Panel
        title="Timeline"
        meta={tl.loading ? 'Loading…' : formatRangeLabel(from, until)}
      >
        <TimeSeries
          data={tl.timeline}
          timeRange={from}
          profileTypeId={profileTypeID}
          startMs={range.start}
          endMs={range.end}
          onRangeSelect={(start, end) =>
            navigate({ set: { from: String(start), until: String(end) } })
          }
        />
      </Panel>

      <Panel
        title="Flamegraph"
        meta={
          fg.loading
            ? 'Loading…'
            : parsed
              ? `${parsed.service} · ${profileTypeLabel(parsed.profileType)}`
              : undefined
        }
      >
        <FlameGraph data={fg.flamegraph} profileTypeId={profileTypeID} />
      </Panel>
    </div>
  );
}
