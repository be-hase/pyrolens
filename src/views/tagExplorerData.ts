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
import { isInternalLabel, toDisplayLabel } from '../queryLang';

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

/** The labels offered as a grouping, in display form. */
export function groupByLabels(names: string[]): string[] {
  // profile_type and service_name are already pinned by the query itself, so
  // grouping by them is never useful.
  return names
    .map(toDisplayLabel)
    .filter(
      (n) =>
        !isInternalLabel(n) && n !== 'service_name' && n !== 'profile_type',
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
