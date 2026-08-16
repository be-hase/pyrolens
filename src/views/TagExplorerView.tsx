import { useEffect, useMemo, useState } from 'react';
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
import {
  formatCell,
  groupByLabels,
  sortRows,
  summarize,
  type SortKey,
} from './tagExplorerData';
import { navigate, useRoute } from '../urlState';
import { ErrorBanner } from './ComparisonPane';
import './TagExplorerView.css';

// Adapted from FLAMEGRAPH_EMPTY_MESSAGE (SingleView.tsx / ComparisonView.tsx):
// there is nothing to break down rather than nothing to draw, so the wording
// says that instead.
const BREAKDOWN_EMPTY_MESSAGE =
  'No profiles matched this query in this range, so there is nothing to ' +
  'break down. Recently ingested profiles can take about a minute to ' +
  'become queryable.';

const MAX_SERIES = 8;

// The breakdown table renders this many rows before making the rest an
// explicit click. A high-cardinality groupBy can produce thousands of rows —
// three buttons and a chip cell apiece — and committing all of them on every
// sort or navigation cost multiple seconds. 50 is comfortably past what
// anyone actually scans by eye, so the cap is never felt in practice, while
// the full set stays one click away for the rare case it matters.
const TABLE_PAGE_SIZE = 50;

// Display placeholder for a series missing the group-by label. Missingness
// itself is tracked structurally (GroupedTimeline.labelValue is null), so
// this is purely cosmetic — it never has to be told apart from a series
// whose label value is literally the string "(none)".
const NONE_LABEL = '(none)';

// The discriminator a table row is keyed on: a genuinely missing label
// (value === null) and a series whose value is literally the string
// "(none)" both display as NONE_LABEL but must stay distinct rows.
const rowKey = (value: string | null) =>
  value === null ? ' none' : 'v' + value;

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
  // A single banner can only show one message, but when both fetches failed
  // a Retry that only re-ran one of them looked dead — the banner would
  // just swap to the other's identical-looking error. So Retry composes
  // every fetch that actually has an error (mirroring SingleView).
  const retries = [
    active && grouped.fetchError ? grouped.retry : undefined,
    profileTypeID && labels.fetchError ? labels.retry : undefined,
  ].filter((r): r is () => void => !!r);
  const retry =
    retries.length > 0 ? () => retries.forEach((r) => r()) : undefined;

  const allSeries = useMemo(
    () =>
      grouped.data.map((g) => ({
        label: g.labelValue ?? NONE_LABEL,
        value: g.labelValue,
        points: g.points,
      })),
    [grouped.data],
  );
  // Shares are computed across every group, not just the ones drawn or
  // listed, or the percentages would be rebased to the visible rows.
  const allRows = useMemo(() => summarize(allSeries), [allSeries]);
  // Only the chart is capped — the value a user hunts is often outside the
  // top 8 by total, so the table lists every row.
  const series = allSeries.slice(0, MAX_SERIES);

  const sortParam = params.get('sort');
  const sortKey: SortKey =
    sortParam === 'avg' || sortParam === 'max' ? sortParam : null;
  const rows = useMemo(() => sortRows(allRows, sortKey), [allRows, sortKey]);
  const toggleSort = (key: SortKey) => {
    // Clicking the active header returns to the default sum/share ranking;
    // clicking another switches to it. Always descending — these are
    // magnitudes and the hunt is "largest first".
    navigate({ set: { sort: sortKey === key ? null : key } });
  };

  // Whether the table has been expanded past TABLE_PAGE_SIZE. A new dataset
  // — a different groupBy or a different query — must not inherit a previous
  // expansion, or a screen that used to need "Show all" stays expanded (and
  // slow to commit) after navigating to one that doesn't need it. Re-sorting
  // the same dataset should *not* reset it, so this keys off groupBy/query
  // rather than `sortKey`. Same previous-value-during-render pattern as
  // TimeRangePicker's `committed`/CalendarPopover's `previousSelected` — an
  // effect would leave one render showing the stale (possibly huge) table
  // before catching up.
  const [prevExpandKey, setPrevExpandKey] = useState(`${groupBy}|${query}`);
  const [showAllRows, setShowAllRows] = useState(false);
  const expandKey = `${groupBy}|${query}`;
  if (prevExpandKey !== expandKey) {
    setPrevExpandKey(expandKey);
    setShowAllRows(false);
  }
  // Sort semantics stay over the full set — sort, then slice — so paging
  // never changes which rows rank where; it only limits how many render.
  const visibleRows = showAllRows ? rows : rows.slice(0, TABLE_PAGE_SIZE);

  // The chip is the row's palette slot in the chart, which ranks by sum —
  // not the table's current sort order — so it is computed from the top 8
  // of `allRows` regardless of how `rows` is currently sorted.
  const chartIndexByValue = useMemo(() => {
    const map = new Map<string, number>();
    allRows
      .slice(0, MAX_SERIES)
      .forEach((row, i) => map.set(rowKey(row.value), i));
    return map;
  }, [allRows]);

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

  // No-frames placeholder for the Breakdown panel. While loading, the
  // Timeline panel above already shows "Loading…" — see FlameGraph's
  // identical reasoning for rendering nothing rather than a second,
  // redundant message. And no contextual claim while the banner already
  // shows this fetch's error — see FlameGraph's identical gate.
  const breakdownEmpty = loading ? null : (
    <Empty message={error ? undefined : BREAKDOWN_EMPTY_MESSAGE} />
  );

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

      {error && <ErrorBanner error={error} retry={retry} />}

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
          breakdownEmpty
        ) : (
          <table className="tag-explorer-table">
            <thead>
              <tr>
                <th />
                <th className="tag-explorer-th-left">{groupBy || 'value'}</th>
                <th aria-sort={sortKey === null ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="tag-explorer-sort-th"
                    onClick={() => toggleSort(null)}
                  >
                    Share
                  </button>
                </th>
                <th aria-sort={sortKey === 'avg' ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="tag-explorer-sort-th"
                    onClick={() => toggleSort('avg')}
                  >
                    Avg
                  </button>
                </th>
                <th aria-sort={sortKey === 'max' ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="tag-explorer-sort-th"
                    onClick={() => toggleSort('max')}
                  >
                    Max
                  </button>
                </th>
                <th className="tag-explorer-th-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const chipIndex = chartIndexByValue.get(rowKey(row.value));
                return (
                  // Keyed on the discriminator, not the display label: a
                  // missing-label bucket and a literal "(none)" bucket both
                  // display as NONE_LABEL but must stay distinct rows.
                  <tr key={rowKey(row.value)}>
                    <td className="tag-explorer-chip-cell">
                      {chipIndex !== undefined && (
                        <span
                          className="multi-timeseries-chip"
                          style={{ background: SERIES_COLORS[chipIndex] }}
                        />
                      )}
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
                    <td className="tag-explorer-num">
                      {row.share.toFixed(1)}%
                    </td>
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
                );
              })}
            </tbody>
          </table>
        )}
        {!showAllRows && rows.length > TABLE_PAGE_SIZE && (
          <button
            type="button"
            className="tag-explorer-show-all"
            onClick={() => setShowAllRows(true)}
          >
            Show all {rows.length} rows
          </button>
        )}
      </Panel>
    </div>
  );
}
