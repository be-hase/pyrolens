import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { formatCell, groupByLabels, summarize } from './tagExplorerData.ts';

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
