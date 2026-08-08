import { Panel } from '@components/Panel';
import { QueryBar } from '@components/QueryBar';
import { TimeSeries } from '@components/TimeSeries';
import { useTimeline } from '@hooks/useProfileData';
import { useEditBuffer } from '@hooks/useEditBuffer';
import { splitQuery } from '../queryLang';
import { formatAbsoluteRange, type TimeRange } from '../time';
import { navigate } from '../urlState';
import type { PaneParams } from './comparisonParams';

// One side of the Comparison/Diff views: a query bar plus a brushable
// timeline spanning the main range, with the pane's own sub-range
// highlighted. Writes to `<side>Query` / `<side>From` / `<side>Until`.
export function ComparisonPane({
  title,
  pane,
  mainRange,
  mainFrom,
  tenantID,
  children,
}: {
  title: string;
  pane: PaneParams;
  mainRange: TimeRange;
  mainFrom: string;
  tenantID?: string;
  children?: React.ReactNode;
}) {
  const { timeline, loading, error } = useTimeline({
    query: pane.query,
    range: mainRange,
    tenantID,
  });
  const { profileTypeID } = splitQuery(pane.query);

  const [draft, setDraft] = useEditBuffer(pane.query);

  return (
    <Panel title={title} meta={formatAbsoluteRange(pane.range)}>
      <div className="comparison-pane">
        <QueryBar
          query={draft}
          committedQuery={pane.query}
          onQueryChange={setDraft}
          onRun={(q) => navigate({ set: { [`${pane.side}Query`]: q } })}
          start={mainRange.start}
          end={mainRange.end}
          tenantID={tenantID}
          loading={loading}
        />
        {error && <div className="app-error">{error}</div>}
        <TimeSeries
          data={timeline}
          timeRange={mainFrom}
          profileTypeId={profileTypeID}
          startMs={mainRange.start}
          endMs={mainRange.end}
          selection={pane.range}
          onRangeSelect={(start, end) =>
            navigate({
              set: {
                [`${pane.side}From`]: String(start),
                [`${pane.side}Until`]: String(end),
              },
            })
          }
        />
        {children}
      </div>
    </Panel>
  );
}
