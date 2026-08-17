import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { MultiTimeSeries, type NamedSeries } from '@components/MultiTimeSeries';
import { SERIES_COLORS } from '@components/seriesColors';
import { Panel } from '@components/Panel';
import { Empty } from '@components/core/Empty';
import { Loading } from '@components/core/Loading';
import {
  fetchGroupedTimelines,
  fetchLabelNames,
  profileTypeUnit,
} from '@api/client';
import { useFetched } from '@hooks/useFetched';
import { malformedMessage } from '@hooks/useProfileData';
import {
  defaultQueryPending,
  splitQuery,
  toInternalLabel,
  upsertMatcher,
} from '../queryLang';
import { timelineStep } from '../time';
import {
  breakdownSettingUp,
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
  servicesSettled,
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

  // Pick a default grouping label once labels arrive, and also fall back to
  // one when the current groupBy is not among them — a query switch (or a
  // deep link) can leave a label named that the new query's series simply
  // don't have, and nothing else in this view ever notices: the fetch below
  // keeps requesting that label forever, painting an empty breakdown while
  // no chip reads as selected.
  //
  // This must not act while `labels.fetching` — useFetched's own contract
  // (see its header) is stale-while-refetching: `labels.data` can still be
  // holding the *previous* query's list for one or more renders after
  // `groupBy` has already moved on, because its own effect hasn't committed
  // the new key's result yet. Resetting against that in-flight list would
  // read a groupBy the new query actually has as "missing" and clobber it
  // before the correct list ever arrives.
  //
  // Nor may a *settled* list missing groupBy always reset: for a relative
  // range "now" advances on every navigation and every auto-refresh tick
  // (see AGENTS.md), and this fetch is keyed on range.start/range.end, so it
  // refires continuously under the same query — not only on a query switch.
  // If one of those background refetches returns a momentarily partial (or
  // differently ordered) list that happens to lack the user's selection,
  // that is a transient flap, not evidence the label is invalid; the pane
  // showing an empty breakdown until the next tick corrects it is fine, but
  // replace-navigating the user's explicit choice away is not — it silently
  // destroys URL state the user chose, and Back cannot undo a replace.
  //
  // So `confirmedRef` remembers the last (labelSelector, tenant, groupBy)
  // triple a settled list actually contained. A reset only fires when the
  // *current* query+tenant+groupBy was never confirmed — covering a fresh
  // deep link (never confirmed at all), a real query switch (confirmed under
  // the old selector, not this one), and a tenant switch (confirmed under
  // the old tenant, not this one — the labels fetch is keyed on tenantID
  // too, and a groupBy valid under one tenant need not exist under another)
  // — while a flap under the same confirmed query and tenant leaves the
  // selection alone.
  const confirmedRef = useRef<{
    selector: string;
    tenant: string;
    groupBy: string;
  } | null>(null);
  useEffect(() => {
    if (labels.fetching) return;
    if (labels.data.length === 0) return;
    if (groupBy && labels.data.includes(groupBy)) {
      confirmedRef.current = {
        selector: labelSelector,
        tenant: tenantID ?? '',
        groupBy,
      };
      return;
    }
    const confirmed = confirmedRef.current;
    if (
      confirmed &&
      confirmed.selector === labelSelector &&
      confirmed.tenant === (tenantID ?? '') &&
      confirmed.groupBy === groupBy
    ) {
      return;
    }
    navigate({ set: { groupBy: labels.data[0] }, replace: true });
  }, [groupBy, labelSelector, tenantID, labels.data, labels.fetching]);

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
  // While the labels fetch (a prerequisite stage of the same pipeline) is
  // still in flight, or has settled non-empty but the default-groupBy effect
  // below hasn't written `groupBy` yet, `active` (and therefore `loading`)
  // is false — but the pipeline is still working, not concluded. Rendering
  // "No data available" / "No profiles matched" during this stage would be
  // a false conclusion. Uses `labels.settled`, not `labels.fetching` — the
  // latter pulses true again on every auto-refresh tick (the labels fetch is
  // keyed on range.start/range.end), which would flip an already-settled,
  // honestly empty breakdown (a query with nothing to group by) back into
  // the spinner on every tick. See breakdownSettingUp (tagExplorerData.ts).
  const settingUp = breakdownSettingUp(
    !!profileTypeID,
    groupBy,
    labels.settled,
    labels.data.length,
  );
  // Startup gap: before the services fetch settles, or after it settles
  // with App's default-query write still due (see App.tsx / queryLang.ts's
  // `defaultQueryPending`), `profileTypeID` is empty because there is no
  // query yet — not because one was asked and matched nothing. Same
  // false-conclusion risk as `settingUp` above; `!servicesSettled` (not
  // `servicesLoading`) for the same reason.
  const startingUp =
    (!servicesSettled || defaultQueryPending(services, params.get('query'))) &&
    !profileTypeID;
  const stillWorking = loading || settingUp || startingUp;
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

  // No-frames placeholder for the Breakdown panel. While loading, this
  // renders Loading rather than nothing — see FlameGraph's identical
  // reasoning: the Timeline panel's own "Loading…" meta is a different
  // panel from the Breakdown table, easy to miss, and now that the timeline
  // chart itself shows a loading placeholder too, a silent Breakdown table
  // would be the one area left with no signal. No contextual claim while
  // the banner already shows this fetch's error — see FlameGraph's
  // identical gate.
  const breakdownEmpty = stillWorking ? (
    <Loading />
  ) : (
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
          stillWorking
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
          loading={stillWorking}
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
