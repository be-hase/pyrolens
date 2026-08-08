// Pure helpers shared by the timeline charts (TimeSeries, MultiTimeSeries)
// and the Tag Explorer breakdown table. Raw sample values arrive in the
// profile type's native unit: nanoseconds for 'ns' profiles, plain bytes
// and counts otherwise.

import { formatMonthDay } from '../time';

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
    return formatMonthDay(tsMs);
  }
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return stepMs < MINUTE ? `${hhmm}:${pad2(d.getSeconds())}` : hhmm;
}

// --- Plot geometry -----------------------------------------------------------
//
// Both charts map a time range across their width and a value range up their
// height. Value 0 sits at `height - padBottom` and the axis maximum at
// `padTop`; the gridlines and the y-axis labels use the same mapping as the
// marks, which is what keeps a peak drawn on a gridline worth that
// gridline's number.

/** Vertical geometry of a plot, in CSS pixels. */
export interface PlotBox {
  height: number;
  padTop: number;
  padBottom: number;
}

/** Both charts leave the same room above and below the plotted area. */
export const PLOT_PAD_TOP = 10;
export const PLOT_PAD_BOTTOM = 4;

const innerHeight = (box: PlotBox) => box.height - box.padTop - box.padBottom;

/** X of a timestamp, in pixels across a plot `width` wide. */
export function timeToX(
  tsMs: number,
  startMs: number,
  durationMs: number,
  width: number,
): number {
  return ((tsMs - startMs) / Math.max(1, durationMs)) * width;
}

/**
 * The inverse of `timeToX`, to whole milliseconds. Drag-to-select navigates
 * to what this returns, so it has to land back on the timestamp under the
 * pointer.
 */
export function xToTime(
  px: number,
  startMs: number,
  durationMs: number,
  width: number,
): number {
  return Math.round(
    startMs + (px / Math.max(1, width)) * Math.max(1, durationMs),
  );
}

/** Y of a value already in display units. */
export function valueToY(
  displayValue: number,
  displayMax: number,
  box: PlotBox,
): number {
  const frac = displayMax > 0 ? displayValue / displayMax : 0;
  return box.height - box.padBottom - Math.min(1, frac) * innerHeight(box);
}

/** Y of a gridline at `frac` of the axis maximum (0 = baseline, 1 = top). */
export function fractionToY(frac: number, box: PlotBox): number {
  return box.height - box.padBottom - frac * innerHeight(box);
}

/**
 * Round tick timestamps covering the range, at `stepMs` apart — which must be
 * positive, as `tickStepMs` guarantees.
 *
 * Snapped to *local* wall-clock boundaries, because `formatTickTime` labels
 * them with local getters: an epoch-aligned day tick sits at 09:00 in UTC+9
 * while its label claims local midnight (and half-hour zones misalign every
 * hourly tick the same way).
 */
export function axisTicks(
  startMs: number,
  durationMs: number,
  stepMs: number,
): number[] {
  const out: number[] = [];
  const end = startMs + durationMs;
  // The offset is re-read at every tick, not extrapolated from the first:
  // across a DST transition a fixed offset walks the ticks an hour off, which
  // shows up as two gridlines labelled with the same date and none for the
  // next one.
  const snap = (ms: number, round: (n: number) => number) => {
    const offsetMs = new Date(ms).getTimezoneOffset() * 60_000;
    return round((ms - offsetMs) / stepMs) * stepMs + offsetMs;
  };

  let ts = snap(startMs, Math.ceil);
  while (ts <= end) {
    if (ts >= startMs) out.push(ts);
    // Re-snapping can land on the tick we came from when the offset shifts;
    // stepping raw keeps the loop moving.
    const next = snap(ts + stepMs, Math.round);
    ts = next > ts ? next : ts + stepMs;
  }
  return out;
}
