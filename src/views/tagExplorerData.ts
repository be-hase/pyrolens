// What the Tag Explorer derives from the grouped timelines it fetched: the
// breakdown table's rows, the labels worth grouping by, and the cell format.
// Kept out of the component so the arithmetic can be checked directly — a
// wrong share or a wrong sort reads as plausible data on screen.

import type { NamedSeries } from '@components/MultiTimeSeries';
import {
  niceMax,
  toDisplayValue,
  yAxisFormatter,
} from '@components/timeseries-utils';
import {
  isInternalLabel,
  isValidLabelName,
  toDisplayLabel,
} from '../queryLang';

export interface TagRow {
  label: string;
  /**
   * The series' discriminator, distinct from `label` when the input had none
   * (label falls back to a display placeholder; value stays null so a
   * genuinely missing value can't be confused with one that merely displays
   * the same).
   */
  value: string | null;
  /** Total of every point, which is what the rows are ranked by. */
  sum: number;
  avg: number;
  max: number;
  /** Percentage of the summed total across all rows. */
  share: number;
}

/** Breakdown rows, largest total first. */
export function summarize(
  series: (NamedSeries & { value?: string | null })[],
): TagRow[] {
  const totals = series.map((s) => ({
    label: s.label,
    // No `value` on the input means the caller has no discriminator to
    // offer either; fall back to the display label rather than null, which
    // is reserved for "the series genuinely lacked this value".
    value: s.value === undefined ? s.label : s.value,
    sum: s.points.reduce((acc, p) => acc + p.value, 0),
    avg: s.points.length
      ? s.points.reduce((acc, p) => acc + p.value, 0) / s.points.length
      : 0,
    max: Math.max(0, ...s.points.map((p) => p.value)),
  }));
  const grandTotal = totals.reduce((acc, t) => acc + t.sum, 0);
  return totals
    .map((t) => ({
      ...t,
      // A profile of nothing at all still has to produce a number.
      share: grandTotal ? (t.sum / grandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.sum - a.sum);
}

/** The table's sort column; `null` is the default sum/share ranking. */
export type SortKey = 'avg' | 'max' | null;

/**
 * Table rows sorted descending by one column, or left in `summarize`'s
 * sum-ranked order when `key` is null. `Array#sort` is stable, so a tie
 * keeps the rows in whatever order they arrived rather than reshuffling on
 * every render.
 */
export function sortRows(rows: TagRow[], key: SortKey): TagRow[] {
  if (key === null) return rows;
  return [...rows].sort((a, b) => b[key] - a[key]);
}

/** The labels offered as a grouping, in display form. */
export function groupByLabels(names: string[]): string[] {
  // profile_type and service_name are already pinned by the query itself, so
  // grouping by them is never useful. Validated, not just filtered — the
  // same reasoning as useLabelSuggestions.ts's names filter: a name outside
  // [a-zA-Z_][a-zA-Z0-9_]* makes it into a Group-by button and a groupBy URL
  // param, and upsertMatcher then silently refuses it and returns the query
  // unchanged, so "select"/"compare" navigate without the matcher ever being
  // added instead of failing loudly.
  return names
    .map(toDisplayLabel)
    .filter(
      (n) =>
        !isInternalLabel(n) &&
        isValidLabelName(n) &&
        n !== 'service_name' &&
        n !== 'profile_type',
    )
    .sort();
}

/**
 * Formats one table cell. Each cell is scaled on its own value rather than a
 * shared axis maximum, so a row that is orders of magnitude smaller than the
 * biggest one still reads as a number instead of 0.
 */
export function formatCell(value: number, unit: string): string {
  const display = toDisplayValue(value, unit);
  return yAxisFormatter(niceMax(display))(display);
}

/**
 * Whether the Timeline/Breakdown pipeline is still working toward its first
 * conclusion, for the stage before `groupBy` has a value — as opposed to
 * concluded (settled) with an answer, even an honestly empty one.
 *
 * `groupBy` empty is not just "no labels fetched yet": TagExplorerView's own
 * default-groupBy effect (a passive effect, so it runs one render after the
 * commit that landed a non-empty `labelsData`) is about to write one the
 * moment the labels fetch settles with a non-empty list. Reporting "settled"
 * in the render before that write lands would paint "No profiles matched" /
 * "No data available" for one frame that the effect immediately corrects.
 *
 * So this stays true for as long as such a write is still coming
 * (`!labelsSettled`, or `labelsSettled` with a non-empty list) and only goes
 * false once either `groupBy` is actually set, or the labels fetch has
 * settled with nothing to group by — the one case where no write is ever
 * coming and the empty conclusion is the honest, final answer.
 */
export function breakdownSettingUp(
  hasQuery: boolean,
  groupBy: string,
  labelsSettled: boolean,
  labelsCount: number,
): boolean {
  return hasQuery && !groupBy && (!labelsSettled || labelsCount > 0);
}
