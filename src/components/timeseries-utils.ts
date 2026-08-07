// Pure helpers shared by the timeline charts (TimeSeries, MultiTimeSeries)
// and the Tag Explorer breakdown table. Raw sample values arrive in the
// profile type's native unit: nanoseconds for 'ns' profiles, plain bytes
// and counts otherwise.

const MONTH_ABBR = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Converts a raw sample value to display units (seconds for time). */
export function toDisplayValue(value: number, unit: string): number {
  return unit === 'ns' ? value / 1e9 : value;
}

/**
 * Rounds up to the next 1·10^n / 2·10^n / 5·10^n so axis maxima land on
 * round numbers. Zero or invalid input yields 1 so axes stay drawable.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const frac = value / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  // toPrecision guards against float dust like 5 * 0.01 → 0.050000000000000003.
  return Number((nice * base).toPrecision(12));
}

const SI_STEPS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
];

/**
 * Builds a label formatter sized to the axis maximum: one SI scale for the
 * whole axis, values shown with at most three significant digits.
 */
export function yAxisFormatter(maxValue: number): (value: number) => string {
  const [factor, suffix] = SI_STEPS.find(
    ([threshold]) => Math.abs(maxValue) >= threshold,
  ) ?? [1, ''];
  return (value: number) => {
    const scaled = value / factor;
    if (scaled === 0) return '0';
    return `${Number(scaled.toPrecision(3))}${suffix}`;
  };
}

const TICK_STEPS_MS = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

const MAX_TICKS = 12;

/** Picks a round x-tick interval producing at most ~12 ticks. */
export function tickStepMs(durationMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (durationMs / step <= MAX_TICKS) return step;
  }
  return Math.ceil(durationMs / MAX_TICKS / DAY) * DAY;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Formats an x-axis tick timestamp (unix ms, local time) at a precision
 * matching the tick interval: dates for day-scale steps, HH:MM for minute
 * scale, HH:MM:SS below that.
 */
export function formatTickTime(tsMs: number, stepMs: number): string {
  const d = new Date(tsMs);
  if (stepMs >= DAY) {
    // Fixed English month names, so ticks don't follow the browser locale.
    return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
  }
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return stepMs < MINUTE ? `${hhmm}:${pad2(d.getSeconds())}` : hhmm;
}
