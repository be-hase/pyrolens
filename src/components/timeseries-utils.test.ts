import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatTickTime,
  niceMax,
  tickStepMs,
  toDisplayValue,
  yAxisFormatter,
} from './timeseries-utils.ts';

describe('toDisplayValue', () => {
  it('converts nanoseconds to seconds for time profiles', () => {
    assert.equal(toDisplayValue(1_500_000_000, 'ns'), 1.5);
    assert.equal(toDisplayValue(0, 'ns'), 0);
  });

  it('passes bytes and counts through unchanged', () => {
    assert.equal(toDisplayValue(2048, 'bytes'), 2048);
    assert.equal(toDisplayValue(42, 'count'), 42);
  });
});

describe('niceMax', () => {
  it('rounds up to the next 1/2/5 × 10^n', () => {
    assert.equal(niceMax(43), 50);
    assert.equal(niceMax(190), 200);
    assert.equal(niceMax(7.3), 10);
    assert.equal(niceMax(1234), 2000);
    assert.equal(niceMax(0.043), 0.05);
  });

  it('keeps already-nice values', () => {
    assert.equal(niceMax(200), 200);
    assert.equal(niceMax(5), 5);
    assert.equal(niceMax(1), 1);
  });

  it('returns 1 for zero or invalid input so axes stay drawable', () => {
    assert.equal(niceMax(0), 1);
    assert.equal(niceMax(-5), 1);
    assert.equal(niceMax(NaN), 1);
    assert.equal(niceMax(Infinity), 1);
  });
});

describe('yAxisFormatter', () => {
  it('formats small axes with up to three significant digits', () => {
    const fmt = yAxisFormatter(50);
    assert.equal(fmt(0), '0');
    assert.equal(fmt(25), '25');
    assert.equal(fmt(24.812), '24.8');
    assert.equal(fmt(4.382), '4.38');
  });

  it('keeps round tick values unadorned', () => {
    const fmt = yAxisFormatter(200);
    assert.equal(fmt(100), '100');
    assert.equal(fmt(200), '200');
  });

  it('applies one SI suffix chosen from the axis maximum', () => {
    const fmt = yAxisFormatter(2_000_000);
    assert.equal(fmt(1_500_000), '1.5M');
    assert.equal(fmt(2_000_000), '2M');
    assert.equal(fmt(500_000), '0.5M');
    assert.equal(yAxisFormatter(4_000)(1_234), '1.23k');
    assert.equal(yAxisFormatter(2e9)(1.5e9), '1.5G');
  });

  it('handles sub-unit values without a suffix', () => {
    assert.equal(yAxisFormatter(0.05)(0.025), '0.025');
  });
});

describe('tickStepMs', () => {
  it('yields 5-minute ticks across one hour', () => {
    assert.equal(tickStepMs(3_600_000), 300_000);
  });

  it('caps tick count at ~12', () => {
    assert.equal(tickStepMs(1_800_000), 300_000); // 30 min → 6 ticks
    assert.equal(tickStepMs(86_400_000), 7_200_000); // 24 h → 12 ticks
    assert.equal(tickStepMs(30_000), 5_000); // 30 s → 6 ticks
  });

  it('falls back to whole-day multiples for very long ranges', () => {
    const step = tickStepMs(365 * 86_400_000);
    assert.equal(step % 86_400_000, 0);
    assert.ok((365 * 86_400_000) / step <= 12);
  });
});

describe('formatTickTime', () => {
  it('uses HH:MM for minute-scale steps', () => {
    const ts = new Date(2026, 7, 7, 12, 35, 0).getTime();
    assert.equal(formatTickTime(ts, 300_000), '12:35');
  });

  it('zero-pads hours and minutes', () => {
    const ts = new Date(2026, 0, 2, 9, 5, 0).getTime();
    assert.equal(formatTickTime(ts, 60_000), '09:05');
  });

  it('includes seconds for sub-minute steps', () => {
    const ts = new Date(2026, 7, 7, 9, 5, 7).getTime();
    assert.equal(formatTickTime(ts, 30_000), '09:05:07');
  });

  it('switches to dates for day-scale steps', () => {
    const ts = new Date(2026, 7, 7, 12, 0, 0).getTime();
    const label = formatTickTime(ts, 86_400_000);
    assert.ok(label.length > 0);
    assert.ok(!label.includes(':'));
  });
});
