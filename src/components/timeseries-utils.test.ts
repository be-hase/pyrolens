import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  axisTicks,
  formatTickTime,
  fractionToY,
  niceMax,
  tickStepMs,
  timeToX,
  toDisplayValue,
  valueToY,
  xToTime,
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

describe('timeToX', () => {
  const RANGE = { start: 1_000_000, duration: 3_600_000, width: 800 };

  it('puts the range start at the left edge and the end at the right', () => {
    assert.equal(timeToX(RANGE.start, RANGE.start, RANGE.duration, 800), 0);
    assert.equal(
      timeToX(RANGE.start + RANGE.duration, RANGE.start, RANGE.duration, 800),
      800,
    );
  });

  it('is linear in between', () => {
    assert.equal(
      timeToX(
        RANGE.start + RANGE.duration / 4,
        RANGE.start,
        RANGE.duration,
        800,
      ),
      200,
    );
    assert.equal(
      timeToX(
        RANGE.start + RANGE.duration / 2,
        RANGE.start,
        RANGE.duration,
        800,
      ),
      400,
    );
  });

  it('runs off the edges for timestamps outside the range', () => {
    // Callers clamp when they need to; the scale itself stays honest so a
    // selection drawn past the edge is not silently pinned to it.
    assert.ok(
      timeToX(RANGE.start - 1_000, RANGE.start, RANGE.duration, 800) < 0,
    );
    assert.ok(
      timeToX(
        RANGE.start + RANGE.duration + 1_000,
        RANGE.start,
        RANGE.duration,
        800,
      ) > 800,
    );
  });

  it('survives a zero-length range instead of dividing by zero', () => {
    assert.ok(Number.isFinite(timeToX(1_000, 1_000, 0, 800)));
  });
});

describe('xToTime', () => {
  const START = 1_786_000_000_000;
  const DURATION = 3_600_000;

  it('inverts timeToX', () => {
    // Drag-to-select navigates to this, so the pixel under the pointer has to
    // come back as the timestamp drawn there.
    for (const ts of [
      START,
      START + 1_000,
      START + DURATION / 3,
      START + DURATION,
    ]) {
      const px = timeToX(ts, START, DURATION, 800);
      assert.equal(xToTime(px, START, DURATION, 800), Math.round(ts));
    }
  });

  it('maps the edges to the range bounds', () => {
    assert.equal(xToTime(0, START, DURATION, 800), START);
    assert.equal(xToTime(800, START, DURATION, 800), START + DURATION);
  });

  it('returns whole milliseconds', () => {
    // 13/700 of an hour is 66857.142857..., so an unrounded result would show
    // up here — the URL carries these as integers.
    const ts = xToTime(13, START, DURATION, 700);
    assert.equal(ts, START + 66_857);
    assert.ok(Number.isInteger(ts));
  });

  it('keeps a drag ordered: a later pixel is a later time', () => {
    let previous = -Infinity;
    for (let px = 0; px <= 800; px += 37) {
      const ts = xToTime(px, START, DURATION, 800);
      assert.ok(ts >= previous, `px ${px}`);
      previous = ts;
    }
  });

  it('survives a zero width instead of dividing by zero', () => {
    assert.equal(xToTime(0, START, DURATION, 0), START);
  });
});

describe('valueToY / fractionToY', () => {
  const BOX = { height: 100, padTop: 10, padBottom: 4 };

  it('puts zero on the baseline and the maximum at the top', () => {
    assert.equal(valueToY(0, 50, BOX), 96);
    assert.equal(valueToY(50, 50, BOX), 10);
  });

  it('grows upwards, so a bigger value sits higher', () => {
    assert.ok(valueToY(40, 50, BOX) < valueToY(10, 50, BOX));
  });

  it('scales marks with the same number the axis labels use', () => {
    // The defect this pins: marks scaled by the raw maximum while the labels
    // were rounded, which read as much as 2x off against a gridline.
    const displayMax = niceMax(43); // 50
    for (const frac of [0, 0.25, 0.5, 1]) {
      assert.equal(
        valueToY(frac * displayMax, displayMax, BOX),
        fractionToY(frac, BOX),
        `fraction ${frac}`,
      );
    }
  });

  it('clamps a value above the axis maximum to the top', () => {
    assert.equal(valueToY(75, 50, BOX), valueToY(50, 50, BOX));
  });

  it('treats an empty axis as all-zero rather than NaN', () => {
    assert.equal(valueToY(0, 0, BOX), 96);
    assert.ok(!Number.isNaN(valueToY(5, 0, BOX)));
  });

  it('uses the box it is given', () => {
    const tall = { height: 140, padTop: 10, padBottom: 4 };
    assert.equal(fractionToY(0, tall), 136);
    assert.equal(fractionToY(1, tall), 10);
  });
});

describe('axisTicks', () => {
  it('starts at the first round step inside the range', () => {
    assert.deepEqual(axisTicks(1_000, 9_000, 5_000), [5_000, 10_000]);
  });

  it('includes a tick landing exactly on the end', () => {
    assert.deepEqual(axisTicks(0, 10_000, 5_000), [0, 5_000, 10_000]);
  });

  it('never runs past the end of the range', () => {
    const start = 1_786_000_123_456;
    const duration = 3_600_000;
    for (const ts of axisTicks(start, duration, 300_000)) {
      assert.ok(ts >= start && ts <= start + duration, String(ts));
    }
  });

  it('spaces every tick by the step', () => {
    const ticks = axisTicks(1_786_000_123_456, 86_400_000, 7_200_000);
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i] - ticks[i - 1], 7_200_000);
    }
  });

  it('produces the tick count tickStepMs aimed for', () => {
    const duration = 3_600_000;
    const ticks = axisTicks(0, duration, tickStepMs(duration));
    assert.ok(ticks.length > 0 && ticks.length <= 13, String(ticks.length));
  });

  it('returns nothing when no round step fits', () => {
    assert.deepEqual(axisTicks(1_001, 500, 5_000), []);
  });

  // formatTickTime labels ticks with local getters, so the snapping has to
  // be local too: an epoch-aligned day tick sits at 09:00 in UTC+9 while its
  // label claims midnight. These hold in whatever zone the tests run in.
  it('lands day-step ticks on local midnight', () => {
    const start = new Date(2026, 7, 1, 13, 30).getTime();
    const ticks = axisTicks(start, 7 * 86_400_000, 86_400_000);
    assert.ok(ticks.length > 0);
    for (const ts of ticks) {
      const d = new Date(ts);
      assert.deepEqual(
        [d.getHours(), d.getMinutes(), d.getSeconds()],
        [0, 0, 0],
        new Date(ts).toString(),
      );
    }
  });

  it('lands hour-step ticks on local whole hours', () => {
    const start = new Date(2026, 7, 7, 5, 17).getTime();
    for (const ts of axisTicks(start, 6 * 3_600_000, 3_600_000)) {
      assert.equal(new Date(ts).getMinutes(), 0, new Date(ts).toString());
    }
  });
});
