import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getValueFormat, groupThousands } from './format.ts';

// format.ts is this project's own code even though it lives in the vendored
// tree — see VENDORED.md, "Replaced". Its arithmetic decides what every
// number in the flame graph and the top table reads as, so it is tested here
// rather than left to a screenshot.

const fmt = (unit: string, value: number) => {
  const d = getValueFormat(unit)(value);
  return `${d.text}${d.suffix ?? ''}`;
};

describe('getValueFormat: durations', () => {
  it('picks the unit the number fits', () => {
    assert.equal(fmt('ns', 0), '0 ns');
    assert.equal(fmt('ns', 512), '512 ns');
    assert.equal(fmt('ns', 1_500), '1.5 µs');
    assert.equal(fmt('ns', 220_000_000), '220 ms');
    assert.equal(fmt('ns', 90_000_000_000), '1.5 min');
  });

  it('steps up when rounding fills the unit', () => {
    // The step is chosen from the raw magnitude but the mantissa is rounded,
    // so without a re-check these render as "1000 µs" and "60 s" — durations
    // the unit beside them cannot hold, and which sort next to their
    // correctly-formatted neighbours a nanosecond away.
    assert.equal(fmt('ns', 999_999), '1 ms');
    assert.equal(fmt('ns', 59_999_999_999), '1 min');
    assert.equal(fmt('ns', 3_599_990_000_000), '1 hour');
    assert.equal(fmt('ns', 86_399_000_000_000), '1 day');
  });

  it('keeps the sign', () => {
    assert.equal(fmt('ns', -999_999), '-1 ms');
  });
});

describe('getValueFormat: bytes and counts', () => {
  it('scales on the binary step for bytes', () => {
    assert.equal(fmt('bytes', 0), '0 B');
    assert.equal(fmt('bytes', 1_023), '1023 B');
    assert.equal(fmt('bytes', 1_024), '1 KiB');
    // Would otherwise read "1024 KiB".
    assert.equal(fmt('bytes', 1_048_575), '1 MiB');
  });

  it('scales on the decimal step for counts', () => {
    assert.equal(fmt('short', 999), '999');
    assert.equal(fmt('short', 1_000), '1 K');
    // Would otherwise read "1000 Bil".
    assert.equal(fmt('short', 999_999_999_999), '1 Tri');
  });

  it('stops at the largest unit it has', () => {
    assert.equal(fmt('short', 1e30), '1000000000000 Quint');
  });
});

describe('getValueFormat: non-numbers', () => {
  it('renders the non-finite ones without asking the browser locale', () => {
    assert.equal(getValueFormat('short')(Number.NaN).text, '');
    assert.equal(
      getValueFormat('short')(Number.POSITIVE_INFINITY).text,
      'Infinity',
    );
  });
});

describe('groupThousands', () => {
  it('groups with a fixed separator, whatever the locale', () => {
    assert.equal(groupThousands(0), '0');
    assert.equal(groupThousands(999), '999');
    assert.equal(groupThousands(1_234_567), '1,234,567');
    assert.equal(groupThousands(-1_234_567), '-1,234,567');
  });

  it('leaves the fractional part alone', () => {
    assert.equal(groupThousands(1234.5678), '1,234.5678');
  });
});
