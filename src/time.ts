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

// Shared by resolveTime and DEFAULT_SPAN_MS's derivation below — both pull
// the same (count, unit) pair out of a "now-N<unit>" string.
const RELATIVE_OFFSET = /^now-(\d+)([smhdw])$/;

// The default main window, written once: App resolves it and the controls
// display it.
export const DEFAULT_FROM = 'now-30m';
export const DEFAULT_UNTIL = 'now';

// Derived from DEFAULT_FROM by parsing it with the same "now-N<unit>"
// machinery resolveTime uses below, rather than the other way round
// (computing DEFAULT_FROM from a raw ms constant). Going from ms to a string
// would silently produce an unparseable "now-1.5m" the moment the span
// stopped dividing evenly by whatever unit was chosen, and every downstream
// reader — formatRangeLabel, previousPeriodParams' relative branch, the
// preset highlight — would degrade with no visible error. Parsing at module
// init instead means a DEFAULT_FROM that doesn't express as a relative
// offset fails loudly at startup, which is what a value that can't is
// supposed to do: this is a build-time mistake, not a runtime one.
const DEFAULT_FROM_MATCH = DEFAULT_FROM.match(RELATIVE_OFFSET);
if (!DEFAULT_FROM_MATCH) {
  throw new Error(
    `DEFAULT_FROM (${DEFAULT_FROM}) must be a "now-N<unit>" relative offset`,
  );
}
export const DEFAULT_SPAN_MS =
  parseInt(DEFAULT_FROM_MATCH[1], 10) * UNIT_MS[DEFAULT_FROM_MATCH[2]];

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
  const rel = value.match(RELATIVE_OFFSET);
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
  const start = resolveTime(from, end - DEFAULT_SPAN_MS, nowMs);
  return start < end ? { start, end } : { start: end - DEFAULT_SPAN_MS, end };
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

const DURATION_UNITS: [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
];

/** "1h 30m" / "7m 30s" / "1d" — the two largest nonzero units, exactly (no
 * rounding: a dropped third unit, if any, is simply floored away). A single
 * rounded unit ("(1h)" for both 89m and 91m) misrepresents a pane window
 * that a user just brushed to a specific span. Mirrors TimeRangePicker.tsx's
 * `formatDuration` (drafted-range summary) rather than importing it — that
 * component is outside this change's touch list — so the two stay aligned
 * in shape without being the same function. */
function formatDurationCompact(ms: number): string {
  const parts: string[] = [];
  let rest = ms;
  for (const [suffix, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0 && parts.length < 2) {
      parts.push(`${n}${suffix}`);
      rest -= n * size;
    }
  }
  return parts.length ? parts.join(' ') : '0s';
}

/**
 * A Comparison/Diff pane's resolved window for its Panel header: the
 * absolute range plus a compact duration, e.g.
 * "Aug 7 09:30 – Aug 7 10:00 (30m)". Built on `formatAbsoluteRange` so the
 * two never disagree about how a timestamp reads.
 */
export function formatPaneWindow(range: TimeRange): string {
  return `${formatAbsoluteRange(range)} (${formatDurationCompact(
    range.end - range.start,
  )})`;
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
    // An absent/bare-"now" `from` resolves to DEFAULT_FROM (App.tsx never
    // writes it into the URL), so its label must read that off DEFAULT_FROM
    // too rather than a hardcoded span that would silently drift from it.
    const rel = !from || from === 'now' ? DEFAULT_FROM.slice(4) : from.slice(4);
    return `Last ${rel}`;
  }
  return formatAbsoluteRange(range);
}

/** Step for timeline queries: ~100 points across the range, min 15s. */
export function timelineStep(range: TimeRange): number {
  return Math.max(15, Math.ceil((range.end - range.start) / 1000 / 100));
}
