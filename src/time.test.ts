import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  formatMonthDay,
  formatPaneWindow,
  formatRangeLabel,
  isRelative,
  resolveRange,
  resolveTime,
  timelineStep,
} from './time.ts';

const NOW = new Date(2026, 7, 7, 12, 0, 0).getTime();
const HOUR = 3_600_000;

describe('isRelative', () => {
  it('accepts "now" and now-<n><unit>', () => {
    assert.equal(isRelative('now'), true);
    for (const unit of ['s', 'm', 'h', 'd', 'w']) {
      assert.equal(isRelative(`now-15${unit}`), true, `unit: ${unit}`);
    }
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'now-',
      'now-1',
      'now-1y',
      'now+1h',
      'now-1.5h',
      'NOW-1h',
      ' now-1h',
      '1786000000000',
    ]) {
      assert.equal(isRelative(bad), false, `input: ${bad}`);
    }
  });
});

describe('resolveTime', () => {
  it('resolves "now" to the supplied clock', () => {
    assert.equal(resolveTime('now', 0, NOW), NOW);
  });

  it('subtracts each relative unit from the supplied clock', () => {
    assert.equal(resolveTime('now-30s', 0, NOW), NOW - 30_000);
    assert.equal(resolveTime('now-5m', 0, NOW), NOW - 300_000);
    assert.equal(resolveTime('now-2h', 0, NOW), NOW - 2 * HOUR);
    assert.equal(resolveTime('now-1d', 0, NOW), NOW - 86_400_000);
    assert.equal(resolveTime('now-1w', 0, NOW), NOW - 604_800_000);
  });

  it('never reads the real clock', () => {
    // Every caller passes the "now" snapshot, so a relative range only
    // advances when navigation refreshes it.
    assert.equal(resolveTime('now-1h', 0, 1_000_000_000_000), 999_996_400_000);
    assert.equal(resolveTime('now', 0, 1_000_000_000_000), 1_000_000_000_000);
  });

  it('passes millisecond timestamps through', () => {
    assert.equal(resolveTime(String(NOW), 0, NOW), NOW);
  });

  it('promotes second timestamps to milliseconds', () => {
    // The classic UI wrote unix seconds; a value still before ~2100 read as
    // seconds is one.
    assert.equal(resolveTime('1786000000', 0, NOW), 1_786_000_000_000);
    assert.equal(resolveTime('4102444799', 0, NOW), 4_102_444_799_000);
  });

  it('keeps pre-2001 millisecond timestamps as milliseconds', () => {
    // The range picker writes ms; reading 1999 as seconds would fling the
    // range ~29000 years into the future.
    const y1999 = new Date(1999, 0, 1).getTime();
    assert.equal(resolveTime(String(y1999), 0, NOW), y1999);
    assert.equal(resolveTime('1000000000000', 0, NOW), 1_000_000_000_000);
  });

  it('falls back for missing values', () => {
    assert.equal(resolveTime(null, 42, NOW), 42);
    assert.equal(resolveTime(undefined, 42, NOW), 42);
    assert.equal(resolveTime('', 42, NOW), 42);
  });

  it('falls back for values it cannot parse', () => {
    for (const bad of ['garbage', 'now-1y', 'now-', '0', '-5', 'NaN']) {
      assert.equal(resolveTime(bad, 42, NOW), 42, `input: ${bad}`);
    }
  });
});

describe('resolveRange', () => {
  it('defaults to the last hour', () => {
    assert.deepEqual(resolveRange(null, null, NOW), {
      start: NOW - HOUR,
      end: NOW,
    });
  });

  it('resolves a relative from against an absolute until', () => {
    assert.deepEqual(resolveRange('now-15m', 'now', NOW), {
      start: NOW - 900_000,
      end: NOW,
    });
  });

  it('keeps an absolute range as given', () => {
    assert.deepEqual(resolveRange('1786000000000', '1786003600000', NOW), {
      start: 1_786_000_000_000,
      end: 1_786_003_600_000,
    });
  });

  it('replaces an inverted range with the hour before its end', () => {
    // Hand-edited URLs and a relative `from` paired with an absolute past
    // `until` both land here; an inverted range would query nothing.
    const end = NOW - 6 * HOUR;
    assert.deepEqual(resolveRange(String(NOW), String(end), NOW), {
      start: end - HOUR,
      end,
    });
    assert.deepEqual(resolveRange('now-1h', String(end), NOW), {
      start: end - HOUR,
      end,
    });
  });

  it('replaces a zero-length range too', () => {
    assert.deepEqual(resolveRange(String(NOW), String(NOW), NOW), {
      start: NOW - HOUR,
      end: NOW,
    });
  });
});

describe('formatRangeLabel', () => {
  const range = (from: string | null, until: string | null) =>
    resolveRange(from, until, NOW);

  it('labels a relative range by its span', () => {
    assert.equal(
      formatRangeLabel('now-30m', 'now', range('now-30m', 'now')),
      'Last 30m',
    );
    assert.equal(
      formatRangeLabel('now-7d', null, range('now-7d', null)),
      'Last 7d',
    );
    assert.equal(
      formatRangeLabel('now-1w', undefined, range('now-1w', null)),
      'Last 1w',
    );
  });

  it('labels an unset range as the default hour', () => {
    assert.equal(formatRangeLabel(null, null, range(null, null)), 'Last 1h');
    assert.equal(
      formatRangeLabel('now', 'now', range('now', 'now')),
      'Last 1h',
    );
  });

  it('spells out an absolute range in fixed English', () => {
    const start = new Date(2026, 0, 2, 9, 5, 0).getTime();
    const end = new Date(2026, 0, 2, 17, 30, 0).getTime();
    assert.equal(
      formatRangeLabel(String(start), String(end), { start, end }),
      'Jan 2 09:05 – Jan 2 17:30',
    );
  });

  it('formats the range it was handed, never re-resolving "now" itself', () => {
    // The caller resolved the range once at navigation time; the label must
    // describe that window, not one recomputed at render time.
    const end = new Date(2026, 7, 7, 8, 0, 0).getTime();
    const start = end - 3_600_000;
    assert.ok(
      formatRangeLabel('now-1h', String(end), { start, end }).endsWith(
        'Aug 7 08:00',
      ),
    );
  });
});

describe('formatPaneWindow', () => {
  it('appends a compact duration to the absolute range', () => {
    const start = new Date(2026, 0, 2, 9, 5, 0).getTime();
    const end = new Date(2026, 0, 2, 9, 35, 0).getTime();
    assert.equal(
      formatPaneWindow({ start, end }),
      'Jan 2 09:05 – Jan 2 09:35 (30m)',
    );
  });

  it('shows the two largest nonzero units exactly, never rounding up', () => {
    const start = 0;
    // The default Comparison/Diff half of a 15-minute fixture window: a
    // single rounded unit misreported this as "(8m)".
    assert.equal(
      formatPaneWindow({ start, end: start + 450_000 }).endsWith('(7m 30s)'),
      true,
    );
    // A rounded single unit would have shown both of these as "(1h)"/"(2h)".
    assert.equal(
      formatPaneWindow({ start, end: start + 89 * 60_000 }).endsWith(
        '(1h 29m)',
      ),
      true,
    );
    assert.equal(
      formatPaneWindow({ start, end: start + 91 * 60_000 }).endsWith(
        '(1h 31m)',
      ),
      true,
    );
    // A nonzero third unit is floored away, not rounded into the second.
    assert.equal(
      formatPaneWindow({ start, end: start + 5_445_000 }).endsWith('(1h 30m)'),
      true,
    );
  });

  it('carries exactly at a unit boundary, with no trailing zero unit', () => {
    assert.equal(
      formatPaneWindow({ start: 0, end: 60 * 60_000 }).endsWith('(1h)'),
      true,
    );
    assert.equal(
      formatPaneWindow({ start: 0, end: 24 * 3_600_000 }).endsWith('(1d)'),
      true,
    );
  });
});

describe('formatMonthDay', () => {
  it('formats as a fixed English month abbreviation and day', () => {
    assert.equal(formatMonthDay(new Date(2026, 7, 7).getTime()), 'Aug 7');
    assert.equal(formatMonthDay(new Date(2026, 0, 1).getTime()), 'Jan 1');
    assert.equal(formatMonthDay(new Date(2026, 11, 31).getTime()), 'Dec 31');
  });
});

describe('timelineStep', () => {
  it('aims for ~100 points across the range', () => {
    assert.equal(timelineStep({ start: NOW - HOUR, end: NOW }), 36);
    assert.equal(timelineStep({ start: NOW - 24 * HOUR, end: NOW }), 864);
  });

  it('never goes below 15 seconds', () => {
    assert.equal(timelineStep({ start: NOW - 600_000, end: NOW }), 15);
    assert.equal(timelineStep({ start: NOW, end: NOW }), 15);
  });

  it('returns whole seconds', () => {
    const step = timelineStep({ start: NOW - 3_333_333, end: NOW });
    assert.equal(step, Math.floor(step));
  });
});
