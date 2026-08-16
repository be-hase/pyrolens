import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { TagRow } from './tagExplorerData.ts';
import {
  formatCell,
  groupByLabels,
  sortRows,
  summarize,
} from './tagExplorerData.ts';

const series = (label: string, values: number[]) => ({
  label,
  points: values.map((value, i) => ({ timestamp: 1_000 + i * 15_000, value })),
});

describe('summarize', () => {
  it('totals, averages and peaks each series', () => {
    const [row] = summarize([series('us-east', [10, 20, 30])]);
    assert.equal(row.sum, 60);
    assert.equal(row.avg, 20);
    assert.equal(row.max, 30);
  });

  it('gives each row its share of the summed total', () => {
    const rows = summarize([
      series('us-east', [60]),
      series('eu-west', [30]),
      series('ap-south', [10]),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.label, r.share]),
      [
        ['us-east', 60],
        ['eu-west', 30],
        ['ap-south', 10],
      ],
    );
  });

  it('makes the shares add up', () => {
    const rows = summarize([
      series('a', [7, 11]),
      series('b', [3]),
      series('c', [101, 2, 5]),
    ]);
    const total = rows.reduce((sum, r) => sum + r.share, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `shares summed to ${total}`);
  });

  it('ranks by total, not by peak', () => {
    // A series that spikes once still ranks below a steadily busier one.
    const rows = summarize([
      series('spiky', [0, 100, 0]),
      series('steady', [40, 40, 40]),
    ]);
    assert.deepEqual(
      rows.map((r) => r.label),
      ['steady', 'spiky'],
    );
    assert.equal(rows[0].max, 40);
    assert.equal(rows[1].max, 100);
  });

  it('keeps the server order between equal totals', () => {
    const rows = summarize([series('a', [5]), series('b', [5])]);
    assert.deepEqual(
      rows.map((r) => r.label),
      ['a', 'b'],
    );
  });

  it('reports zeros rather than NaN for an empty profile', () => {
    // Everything divides by the grand total, which is 0 here.
    const rows = summarize([series('a', [0]), series('b', [])]);
    for (const row of rows) {
      assert.equal(row.share, 0, row.label);
      assert.equal(row.avg, 0, row.label);
      assert.equal(row.max, 0, row.label);
      assert.ok(!Number.isNaN(row.sum), row.label);
    }
  });

  it('averages over the points it has, not the ones it wanted', () => {
    const [row] = summarize([series('a', [10, 20])]);
    assert.equal(row.avg, 15);
  });

  it('handles a series with no points at all', () => {
    const [row] = summarize([series('idle', [])]);
    assert.equal(row.sum, 0);
    assert.equal(row.avg, 0);
    assert.equal(row.max, 0);
  });

  it('returns nothing for no series', () => {
    assert.deepEqual(summarize([]), []);
  });

  it('does not mutate its input', () => {
    const input = [series('b', [1]), series('a', [9])];
    const before = input.map((s) => s.label);
    summarize(input);
    assert.deepEqual(
      input.map((s) => s.label),
      before,
    );
  });

  it('defaults value to the label when the input has none', () => {
    const rows = summarize([series('us-east', [1])]);
    assert.equal(rows[0].value, 'us-east');
  });

  it('preserves a null value through ranking, distinct from a same-looking label', () => {
    // The Tag Explorer's placeholder for a missing label and a literal
    // "(none)" value both display the same; only `value` tells them apart.
    const rows = summarize([
      { ...series('(none)', [10]), value: '(none)' },
      { ...series('(none)', [5]), value: null },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.label, r.value]),
      [
        ['(none)', '(none)'],
        ['(none)', null],
      ],
    );
  });
});

describe('sortRows', () => {
  // Deliberately in none of the three orders (sum, avg or max) each column
  // would produce, so a test passing by accident — because one order
  // happened to match the input — is not possible. In particular, `null`
  // must leave input order alone: the old fixture here happened to already
  // be sum-descending, so a null branch that (wrongly) re-sorted by sum
  // instead of passing the array through untouched would still have passed.
  const rows: TagRow[] = [
    { label: 'a', value: 'a', sum: 10, avg: 5, max: 8, share: 17 },
    { label: 'b', value: 'b', sum: 30, avg: 9, max: 12, share: 50 },
    { label: 'c', value: 'c', sum: 20, avg: 20, max: 5, share: 33 },
  ];

  it('sorts descending by avg', () => {
    assert.deepEqual(
      sortRows(rows, 'avg').map((r) => r.label),
      ['c', 'b', 'a'],
    );
  });

  it('sorts descending by max', () => {
    assert.deepEqual(
      sortRows(rows, 'max').map((r) => r.label),
      ['b', 'a', 'c'],
    );
  });

  it('null preserves input order', () => {
    assert.deepEqual(sortRows(rows, null), rows);
  });

  it('keeps tied rows in their input order', () => {
    const tied: TagRow[] = [
      { label: 'x', value: 'x', sum: 5, avg: 5, max: 5, share: 50 },
      { label: 'y', value: 'y', sum: 5, avg: 5, max: 5, share: 50 },
    ];
    assert.deepEqual(
      sortRows(tied, 'avg').map((r) => r.label),
      ['x', 'y'],
    );
  });

  it('does not mutate its input', () => {
    const before = rows.map((r) => r.label);
    sortRows(rows, 'avg');
    assert.deepEqual(
      rows.map((r) => r.label),
      before,
    );
  });
});

describe('groupByLabels', () => {
  it('offers ordinary labels, sorted', () => {
    assert.deepEqual(groupByLabels(['region', 'pod', 'namespace']), [
      'namespace',
      'pod',
      'region',
    ]);
  });

  it('drops the labels the query already pins', () => {
    // Grouping by either would produce a single row saying what the query
    // said.
    assert.deepEqual(
      groupByLabels(['service_name', 'region', '__profile_type__']),
      ['region'],
    );
  });

  it('drops internal labels', () => {
    assert.deepEqual(
      groupByLabels(['__name__', '__session_id__', 'region', '__type__']),
      ['region'],
    );
  });

  it('returns nothing when there is nothing to group by', () => {
    assert.deepEqual(groupByLabels([]), []);
    assert.deepEqual(groupByLabels(['service_name', '__profile_type__']), []);
  });
});

describe('formatCell', () => {
  it('shows nanoseconds as seconds', () => {
    assert.equal(formatCell(1_500_000_000, 'ns'), '1.5');
    assert.equal(formatCell(90_000_000_000, 'ns'), '90');
  });

  it('leaves bytes and counts in their own unit', () => {
    assert.equal(formatCell(2048, 'bytes'), '2.05k');
    assert.equal(formatCell(42, 'count'), '42');
  });

  it('scales each cell on its own value', () => {
    // A row orders of magnitude below the biggest one still reads as a
    // number rather than rounding away to 0.
    assert.equal(formatCell(3, 'count'), '3');
    assert.equal(formatCell(3_000_000, 'count'), '3M');
  });

  it('shows zero as zero', () => {
    assert.equal(formatCell(0, 'ns'), '0');
    assert.equal(formatCell(0, 'count'), '0');
  });
});
