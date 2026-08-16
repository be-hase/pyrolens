import { useEffect, useMemo } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { MultiTimeSeries, type NamedSeries } from '@components/MultiTimeSeries';
import { SERIES_COLORS } from '@components/seriesColors';
import { Panel } from '@components/Panel';
import { Empty } from '@components/core/Empty';
import {
  fetchGroupedTimelines,
  fetchLabelNames,
  profileTypeUnit,
} from '@api/client';
import { useFetched } from '@hooks/useFetched';
import { malformedMessage } from '@hooks/useProfileData';
import { splitQuery, toInternalLabel, upsertMatcher } from '../queryLang';
import { timelineStep } from '../time';
import { formatCell, groupByLabels, summarize } from './tagExplorerData';
import { navigate, useRoute } from '../urlState';
import './TagExplorerView.css';

const MAX_SERIES = 8;

// Display placeholder for a series missing the group-by label. Missingness
// itself is tracked structurally (GroupedTimeline.labelValue is null), so
// this is purely cosmetic — it never has to be told apart from a series
// whose label value is literally the string "(none)".
const NONE_LABEL = '(none)';

// Break down a profile by one label: a timeline per label value plus a table
// with totals. Rows link into Single / Comparison / Diff with the matcher
// applied. The grouping label lives in the `groupBy` URL param.
export function TagExplorerView({
  services,
  servicesLoading,
  query,
  from,
  until,
  range,
  tenantID,
}: ViewProps) {
  const { profileTypeID, labelSelector } = splitQuery(query);

  const { params } = useRoute();
  const groupBy = params.get('groupBy') ?? '';

  // Available grouping labels for the current query.
  const labels = useFetched<string[]>(
    [],
    !!profileTypeID,
    (signal) =>
      fetchLabelNames([labelSelector], range.start, range.end, signal).then(
        groupByLabels,
      ),
    [labelSelector, range.start, range.end, tenantID],
  );

  // Pick a default grouping label once labels arrive.
  useEffect(() => {
    if (groupBy || labels.data.length === 0) return;
    navigate({ set: { groupBy: labels.data[0] }, replace: true });
  }, [groupBy, labels.data]);

  const active = !!profileTypeID && !!groupBy;
  const grouped = useFetched(
    [] as { labelValue: string | null; points: NamedSeries['points'] }[],
    active,
    (signal) =>
      fetchGroupedTimelines(
        {
          profileTypeID,
          labelSelector,
          start: range.start,
          end: range.end,
          step: timelineStep(range),
          groupBy: toInternalLabel(groupBy),
        },
        signal,
      ),
    [profileTypeID, labelSelector, groupBy, range.start, range.end, tenantID],
  );
  const loading = active && grouped.fetching;
  const error =
    malformedMessage(query) ??
    (active ? grouped.fetchError : null) ??
    (profileTypeID ? labels.fetchError : null);

  const allSeries = useMemo(
    () =>
      grouped.data.map((g) => ({
        label: g.labelValue ?? NONE_LABEL,
        value: g.labelValue,
        points: g.points,
      })),
    [grouped.data],
  );
  // Shares are computed across every group; only the top slice is drawn and
  // listed, or the percentages would be rebased to the visible rows.
  const allRows = useMemo(() => summarize(allSeries), [allSeries]);
  const series = allSeries.slice(0, MAX_SERIES);
  const rows = allRows.slice(0, MAX_SERIES);

  const unit = profileTypeUnit(profileTypeID);
  const fmt = (v: number) => formatCell(v, unit);

  // Only a genuinely missing label becomes the "no such label" matcher; a
  // series whose value is literally the string "(none)" is passed through
  // (upsertMatcher escapes/quotes it like any other value).
  const matcherValue = (value: string | null) => (value === null ? '' : value);

  const selectRow = (value: string | null) => {
    navigate({
      path: '/',
      set: { query: upsertMatcher(query, groupBy, matcherValue(value)) },
    });
  };

  const compareRow = (
    value: string | null,
    target: '/comparison' | '/diff',
  ) => {
    const withMatcher = upsertMatcher(query, groupBy, matcherValue(value));
    navigate({
      path: target,
      // Clear any pane ranges brushed on a previous visit, so the panes
      // start from their default halves of the main range.
      set: {
        leftQuery: query,
        rightQuery: withMatcher,
        leftFrom: null,
        leftUntil: null,
        rightFrom: null,
        rightUntil: null,
      },
    });
  };

  return (
    <div className="app-content">
      <ControlsBar
        services={services}
        servicesLoading={servicesLoading}
        query={query}
        from={from}
        until={until}
        range={range}
      />

      {labels.data.length > 0 && (
        <div className="tag-explorer-labels">
          <span className="tag-explorer-labels-title">Group by</span>
          {labels.data.map((label) => (
            <button
              key={label}
              type="button"
              className={`tag-explorer-label${label === groupBy ? ' active' : ''}`}
              aria-pressed={label === groupBy}
              onClick={() => navigate({ set: { groupBy: label } })}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {error && <div className="app-error">{error}</div>}

      <Panel
        title={groupBy ? `Timeline by ${groupBy}` : 'Timeline'}
        meta={
          loading
            ? 'Loading…'
            : allRows.length > MAX_SERIES
              ? `top ${MAX_SERIES} of ${allRows.length} series`
              : undefined
        }
      >
        <MultiTimeSeries
          series={series}
          profileTypeId={profileTypeID}
          startMs={range.start}
          endMs={range.end}
        />
      </Panel>

      <Panel title="Breakdown">
        {rows.length === 0 ? (
          <Empty />
        ) : (
          <table className="tag-explorer-table">
            <thead>
              <tr>
                <th />
                <th className="tag-explorer-th-left">{groupBy || 'value'}</th>
                <th>Share</th>
                <th>Avg</th>
                <th>Max</th>
                <th className="tag-explorer-th-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                // Keyed on the discriminator, not the display label: a
                // missing-label bucket and a literal "(none)" bucket both
                // display as NONE_LABEL but must stay distinct rows.
                <tr key={row.value === null ? ' none' : 'v' + row.value}>
                  <td className="tag-explorer-chip-cell">
                    {/* Rows and series come from the same ranking, so the
                        row's position is its palette slot in the chart. */}
                    <span
                      className="multi-timeseries-chip"
                      style={{ background: SERIES_COLORS[i] }}
                    />
                  </td>
                  <td className="tag-explorer-value-cell">
                    <button
                      type="button"
                      className="tag-explorer-value-link"
                      title="Open in Single view"
                      onClick={() => selectRow(row.value)}
                    >
                      {row.label}
                    </button>
                  </td>
                  <td className="tag-explorer-num">{row.share.toFixed(1)}%</td>
                  <td className="tag-explorer-num">{fmt(row.avg)}</td>
                  <td className="tag-explorer-num">{fmt(row.max)}</td>
                  <td className="tag-explorer-actions">
                    <button
                      type="button"
                      onClick={() => compareRow(row.value, '/comparison')}
                    >
                      Compare
                    </button>
                    <button
                      type="button"
                      onClick={() => compareRow(row.value, '/diff')}
                    >
                      Diff
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
