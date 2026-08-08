import { FieldType, type Field } from './data';
import type { Theme } from './theme';

/**
 * Value formatting, replacing `@grafana/data`'s `getValueFormat` /
 * `getDisplayProcessor`.
 *
 * Output shape matches what the flame graph rendered before: the metadata pill
 * reads `2.11 hour | 7.58 Tri samples (Time)`, and the top table shows values
 * like `1.78 hour`, `12.08 min`, `220 ms`.
 *
 * `suffix` always carries its own leading space (`' hour'`, `' Tri'`) because
 * every caller concatenates `text + suffix`. The one exception is the unscaled
 * step of the `short` unit, which has no suffix at all (`''`).
 */

export interface DisplayValue {
  text: string;
  numeric: number;
  suffix?: string;
}

export type DisplayProcessor = (value: unknown) => DisplayValue;
export type ValueFormatter = (value: number, decimals?: number) => DisplayValue;

/**
 * Default precision. Values are rounded to this many decimals and trailing
 * zeros are dropped, so whole numbers stay whole (`220 ms`) while fractions
 * keep two digits (`35.67 min`).
 */
const DEFAULT_DECIMALS = 2;

function toFixed(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const places = Math.max(0, Math.min(20, decimals ?? DEFAULT_DECIMALS));
  const factor = Math.pow(10, places);
  return String(Math.round(value * factor) / factor);
}

function invalid(value: number): DisplayValue | undefined {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { text: '', numeric: Number.NaN, suffix: '' };
  }
  if (!Number.isFinite(value)) {
    // Not toLocaleString: the browser locale must not leak into the UI.
    return { text: String(value), numeric: value, suffix: '' };
  }
  return undefined;
}

/**
 * "1234567" → "1,234,567" with a fixed separator — the sample counts in the
 * tooltip must not follow the browser locale (the app is English throughout).
 */
export function groupThousands(value: number): string {
  const [int, frac] = String(value).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/**
 * Divides by `factor` until the value fits the current unit step.
 * `units` entries already include their leading space where they need one.
 */
function scaledUnits(factor: number, units: string[]): ValueFormatter {
  return (value, decimals) => {
    const bail = invalid(value);
    if (bail) {
      return bail;
    }

    let step = 0;
    let scaled = value;
    while (Math.abs(scaled) >= factor && step < units.length - 1) {
      scaled /= factor;
      step++;
    }

    return {
      text: toFixed(scaled, decimals),
      numeric: value,
      suffix: units[step],
    };
  };
}

const NS = 1;
const US = 1000 * NS;
const MS = 1000 * US;
const SECOND = 1000 * MS;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Nanoseconds to a human duration: ns / µs / ms / s / min / hour / day. */
const nanoseconds: ValueFormatter = (value, decimals) => {
  const bail = invalid(value);
  if (bail) {
    return bail;
  }

  const abs = Math.abs(value);
  const scale = (divisor: number, suffix: string): DisplayValue => ({
    text: toFixed(value / divisor, decimals),
    numeric: value,
    suffix,
  });

  if (abs < US) {
    return scale(NS, ' ns');
  }
  if (abs < MS) {
    return scale(US, ' µs');
  }
  if (abs < SECOND) {
    return scale(MS, ' ms');
  }
  if (abs < MINUTE) {
    return scale(SECOND, ' s');
  }
  if (abs < HOUR) {
    return scale(MINUTE, ' min');
  }
  if (abs < DAY) {
    return scale(HOUR, ' hour');
  }
  return scale(DAY, ' day');
};

/** 1000-based SI, using Grafana's wording so `7.58 Tri` still reads the same. */
const short = scaledUnits(1000, [
  '',
  ' K',
  ' Mil',
  ' Bil',
  ' Tri',
  ' Quadr',
  ' Quint',
]);

/** 1024-based binary sizes. */
const bytes = scaledUnits(1024, [
  ' B',
  ' KiB',
  ' MiB',
  ' GiB',
  ' TiB',
  ' PiB',
  ' EiB',
]);

const percent: ValueFormatter = (value, decimals) => {
  const bail = invalid(value);
  if (bail) {
    return bail;
  }
  return { text: toFixed(value, decimals), numeric: value, suffix: '%' };
};

/**
 * `unit` is one of `'ns' | 'bytes' | 'short' | undefined`; anything unknown
 * falls back to `short`.
 */
export function getValueFormat(unit?: string): ValueFormatter {
  switch (unit) {
    case 'ns':
    case 'nanoseconds':
      return nanoseconds;
    case 'bytes':
    case 'decbytes':
      return bytes;
    case 'percent':
    case 'percentunit':
      return percent;
    default:
      return short;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return Number.NaN;
}

/** Builds a processor bound to a field's configured unit. */
export function getDisplayProcessor(options: {
  field: Field;
  theme?: Theme;
}): DisplayProcessor {
  const { field } = options;

  if (field.type !== FieldType.number && field.type !== FieldType.time) {
    return (value) => ({
      text: value === null || value === undefined ? '' : String(value),
      numeric: Number.NaN,
    });
  }

  const formatter = getValueFormat(field.config?.unit);

  return (value) => {
    const numeric = toNumber(value);
    if (Number.isNaN(numeric)) {
      return {
        text: value === null || value === undefined ? '' : String(value),
        numeric: Number.NaN,
        suffix: '',
      };
    }
    return formatter(numeric);
  };
}
