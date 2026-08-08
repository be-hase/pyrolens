// Time range values as they appear in the URL: either a relative expression
// ("now", "now-1h", "now-30m") or an absolute unix-millisecond timestamp.
// Matches the conventions of the classic Pyroscope UI so URLs stay readable.

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// The default main window, written once: App resolves it and the controls
// display it, and the two must never disagree.
export const DEFAULT_FROM = 'now-1h';
export const DEFAULT_UNTIL = 'now';

export function isRelative(value: string): boolean {
  return value === 'now' || /^now-\d+[smhdw]$/.test(value);
}

/** Resolves a URL time value to unix ms. Falls back to `fallback` when unparseable. */
export function resolveTime(
  value: string | null | undefined,
  fallback: number,
  nowMs: number,
): number {
  if (!value) return fallback;
  if (value === 'now') return nowMs;
  const rel = value.match(/^now-(\d+)([smhdw])$/);
  if (rel) return nowMs - parseInt(rel[1], 10) * (UNIT_MS[rel[2]] ?? 60_000);
  const abs = Number(value);
  if (Number.isFinite(abs) && abs > 0) {
    // Accept unix seconds too (classic UI used them): a value that stays
    // before ~2100 as seconds is seconds. Larger values are milliseconds —
    // including pre-2001 dates from the range picker, which a blanket
    // "small means seconds" rule would fling ~29000 years into the future.
    return abs < 4_102_444_800 ? abs * 1000 : abs;
  }
  return fallback;
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Aug 7" — fixed English, so labels don't follow the browser locale. */
export function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

export interface TimeRange {
  start: number;
  end: number;
}

export function resolveRange(
  from: string | null | undefined,
  until: string | null | undefined,
  nowMs: number,
): TimeRange {
  const end = resolveTime(until, nowMs, nowMs);
  const start = resolveTime(from, end - 3_600_000, nowMs);
  return start < end ? { start, end } : { start: end - 3_600_000, end };
}

/** "Aug 7 09:30 – Aug 7 10:30" for an already-resolved range. */
export function formatAbsoluteRange({ start, end }: TimeRange): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`;
    return `${formatMonthDay(ms)} ${time}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Label for the main range button. Takes the range App already resolved
 * rather than resolving again: calling `Date.now()` here would run during
 * render and drift away from the frozen "now" the data was fetched with.
 */
export function formatRangeLabel(
  from: string | null | undefined,
  until: string | null | undefined,
  range: TimeRange,
): string {
  if ((!until || until === 'now') && (!from || isRelative(from))) {
    const rel = !from || from === 'now' ? '1h' : from.slice(4);
    return `Last ${rel}`;
  }
  return formatAbsoluteRange(range);
}

/** Step for timeline queries: ~100 points across the range, min 15s. */
export function timelineStep(range: TimeRange): number {
  return Math.max(15, Math.ceil((range.end - range.start) / 1000 / 100));
}
