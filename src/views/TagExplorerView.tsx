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
import { splitQuery, toInternalLabel, upsertMatcher } from '../queryLang';
import { timelineStep } from '../time';
import { formatCell, groupByLabels, summarize } from './tagExplorerData';
import { navigate, useRoute } from '../urlState';
import './TagExplorerView.css';

const MAX_SERIES = 8;

// Break down a profile by one label: a timeline per label value plus a table
// with totals. Rows link into Single / Comparison / Diff with the matcher
// applied. The grouping label lives in the `groupBy` URL param.
export function TagExplorerView({
  services,
  servicesLoading,
  query,
  range,
  tenantID,
}: ViewProps) {
  const { profileTypeID, labelSelector } = splitQuery(query);

  const { params } = useRoute();
  const groupBy = params.get('groupBy') ?? '';

  const [labels, setLabels] = useState<string[]>([]);
  const [series, setSeries] = useState<NamedSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Derived so an aborted run can't leave the spinner stuck on.
  const active = !!profileTypeID && !!groupBy;
  const loading = active && fetching;

  // Available grouping labels for the current query.
  useEffect(() => {
    if (!profileTypeID) return;
    const controller = new AbortController();
    fetchLabelNames([labelSelector], range.start, range.end, controller.signal)
      .then((names) => {
        if (!controller.signal.aborted) {
          setLabels(groupByLabels(names));
          setLabelsError(null);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setLabelsError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [profileTypeID, labelSelector, range.start, range.end, tenantID]);

  // Pick a default grouping label once labels arrive.
  useEffect(() => {
    if (groupBy || labels.length === 0) return;
    navigate({ set: { groupBy: labels[0] }, replace: true });
  }, [groupBy, labels]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function load() {
      setFetching(true);
      try {
        const grouped = await fetchGroupedTimelines(
          {
            profileTypeID,
            labelSelector,
            start: range.start,
            end: range.end,
            step: timelineStep(range),
            groupBy: toInternalLabel(groupBy),
            limit: MAX_SERIES,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSeries(
          grouped.map((g) => ({ label: g.labelValue, points: g.points })),
        );
        setError(null);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setFetching(false);
      }
    }
    load();

    return () => controller.abort();
  }, [active, profileTypeID, labelSelector, groupBy, range, tenantID]);

  const rows = useMemo(() => summarize(series), [series]);

  const unit = profileTypeUnit(profileTypeID);
  const fmt = (v: number) => formatCell(v, unit);

  const selectRow = (value: string) => {
    navigate({
      path: '/',
      set: { query: upsertMatcher(query, groupBy, value) },
    });
  };

  const compareRow = (value: string, target: '/comparison' | '/diff') => {
    const withMatcher = upsertMatcher(query, groupBy, value);
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
      <ControlsBar services={services} servicesLoading={servicesLoading} />

      {labels.length > 0 && (
        <div className="tag-explorer-labels">
          <span className="tag-explorer-labels-title">Group by</span>
          {labels.map((label) => (
            <button
              key={label}
              type="button"
              className={`tag-explorer-label${label === groupBy ? ' active' : ''}`}
              onClick={() => navigate({ set: { groupBy: label } })}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {(error ?? labelsError) && (
        <div className="app-error">{error ?? labelsError}</div>
      )}

      <Panel
        title={groupBy ? `Timeline by ${groupBy}` : 'Timeline'}
        meta={
          loading
            ? 'Loading…'
            : series.length === MAX_SERIES
              ? `top ${MAX_SERIES} series`
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
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="tag-explorer-chip-cell">
                    <span
                      className="multi-timeseries-chip"
                      style={{
                        background:
                          SERIES_COLORS[
                            series.findIndex((s) => s.label === row.label)
                          ],
                      }}
                    />
                  </td>
                  <td className="tag-explorer-value-cell">
                    <button
                      type="button"
                      className="tag-explorer-value-link"
                      title="Open in Single view"
                      onClick={() => selectRow(row.label)}
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
                      onClick={() => compareRow(row.label, '/comparison')}
                    >
                      Compare
                    </button>
                    <button
                      type="button"
                      onClick={() => compareRow(row.label, '/diff')}
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
