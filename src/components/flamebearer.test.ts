import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { DataFrame } from '@lib/flamegraph';
import {
  diffFlamebearerToDataFrame,
  flamebearerToDataFrame,
  grafanaUnit,
} from './flamebearer.ts';

/** Reads one output column out of the decoded frame. */
const column = (frame: DataFrame | undefined, name: string) =>
  frame?.fields.find((f) => f.name === name)?.values;

const single = (names: string[], levels: number[][], unit = 'ns') =>
  flamebearerToDataFrame({ names, levels }, unit);

// Diff levels arrive as strings on the wire; written as numbers here for
// legibility and stringified the way the client does.
const diff = (names: string[], levels: number[][], unit = 'ns') =>
  diffFlamebearerToDataFrame(
    { names, levels: levels.map((v) => ({ values: v.map(String) })) },
    unit,
  );

describe('grafanaUnit', () => {
  it('passes through the units the flame graph knows', () => {
    assert.equal(grafanaUnit('ns'), 'ns');
    assert.equal(grafanaUnit('bytes'), 'bytes');
  });

  it('falls back to "short" for everything else', () => {
    assert.equal(grafanaUnit('count'), 'short');
    assert.equal(grafanaUnit(''), 'short');
  });
});

describe('flamebearerToDataFrame', () => {
  it('decodes a single root', () => {
    const frame = single(['total'], [[0, 100, 0, 0]]);
    assert.equal(frame?.length, 1);
    assert.deepEqual(column(frame, 'label'), ['total']);
    assert.deepEqual(column(frame, 'level'), [0]);
    assert.deepEqual(column(frame, 'value'), [100]);
    assert.deepEqual(column(frame, 'self'), [0]);
  });

  it('emits fields in flame graph order, typed and carrying the unit', () => {
    const frame = single(['total'], [[0, 100, 0, 0]], 'bytes');
    assert.deepEqual(
      frame?.fields.map((f) => [f.name, f.type, f.config.unit]),
      [
        ['label', 'string', undefined],
        ['level', 'number', undefined],
        ['value', 'number', 'bytes'],
        ['self', 'number', 'bytes'],
      ],
    );
  });

  it('walks children depth-first', () => {
    const frame = single(
      ['total', 'a', 'b'],
      [
        [0, 100, 0, 0],
        [0, 60, 60, 1, 10, 30, 30, 2],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['total', 'a', 'b']);
    assert.deepEqual(column(frame, 'level'), [0, 1, 1]);
    assert.deepEqual(column(frame, 'value'), [100, 60, 30]);
    assert.deepEqual(column(frame, 'self'), [0, 60, 30]);
  });

  it('accumulates gaps to place a bar under the right parent', () => {
    // A row's gaps are relative to the previous bar's end, so only the
    // running total says which parent's extent a bar falls inside.
    const frame = single(
      ['A', 'B', 'a1', 'b1'],
      [
        [0, 50, 0, 0, 0, 50, 0, 1],
        [10, 10, 10, 2, 50, 20, 20, 3],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['A', 'a1', 'B', 'b1']);
    assert.deepEqual(column(frame, 'level'), [0, 1, 0, 1]);
    assert.deepEqual(column(frame, 'value'), [50, 10, 50, 20]);
  });

  it('skips zero-width bars but still counts their gaps', () => {
    const frame = single(
      ['A', 'gone', 'a1'],
      [
        [0, 100, 0, 0],
        [20, 0, 0, 1, 0, 30, 30, 2],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['A', 'a1']);
    assert.deepEqual(column(frame, 'value'), [100, 30]);
  });

  it('drops bars that start left of their parent', () => {
    // Malformed input: with the root pushed 50 ticks in, nothing can begin
    // at 0 and still be its child.
    const frame = single(
      ['A', 'stray'],
      [
        [50, 50, 0, 0],
        [0, 10, 10, 1],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['A']);
  });

  it('labels an out-of-range name index as empty', () => {
    const frame = single(['total'], [[0, 100, 0, 7]]);
    assert.deepEqual(column(frame, 'label'), ['']);
  });

  it('ignores a trailing partial bar', () => {
    const frame = single(['total', 'x'], [[0, 100, 0, 0, 0, 50]]);
    assert.deepEqual(column(frame, 'label'), ['total']);
  });

  it('returns undefined when there is nothing to draw', () => {
    assert.equal(single([], []), undefined);
    assert.equal(single(['total'], [[]]), undefined);
    assert.equal(single(['total'], [[0, 0, 0, 0]]), undefined);
  });

  it('decodes a profile deeper than the JS call stack', () => {
    // A recursive walk blows up somewhere under 7000 frames and takes the
    // whole app down with it; the decoder keeps its own stack for this.
    const depth = 20_000;
    const levels = Array.from({ length: depth }, () => [0, 100, 0, 0]);
    const frame = single(['f'], levels);
    assert.equal(frame?.length, depth);
    assert.equal(column(frame, 'level')?.at(-1), depth - 1);
  });

  it('decodes a wide row without dropping bars', () => {
    const width = 5000;
    const row: number[] = [];
    for (let i = 0; i < width; i++) row.push(0, 1, 1, 1);
    const frame = single(['total', 'leaf'], [[0, width, 0, 0], row]);
    assert.equal(frame?.length, width + 1);
  });
});

describe('diffFlamebearerToDataFrame', () => {
  it('decodes both sides of a bar from the wire strings', () => {
    const frame = diffFlamebearerToDataFrame(
      { names: ['total'], levels: [{ values: '0 60 10 0 40 5 0'.split(' ') }] },
      'ns',
    );
    assert.equal(frame?.length, 1);
    assert.deepEqual(column(frame, 'label'), ['total']);
    assert.deepEqual(column(frame, 'value'), [60]);
    assert.deepEqual(column(frame, 'self'), [10]);
    assert.deepEqual(column(frame, 'valueRight'), [40]);
    assert.deepEqual(column(frame, 'selfRight'), [5]);
  });

  it('emits the four diff columns with the unit', () => {
    const frame = diff(['total'], [[0, 1, 0, 0, 1, 0, 0]], 'ns');
    assert.deepEqual(
      frame?.fields.map((f) => [f.name, f.config.unit]),
      [
        ['label', undefined],
        ['level', undefined],
        ['value', 'ns'],
        ['self', 'ns'],
        ['valueRight', 'ns'],
        ['selfRight', 'ns'],
      ],
    );
  });

  it('keeps a frame present on only one side', () => {
    // Added and removed frames are the point of the diff view: a zero on one
    // side must not make the bar disappear.
    const frame = diff(
      ['total', 'added', 'removed'],
      [
        [0, 50, 0, 0, 50, 0, 0],
        [0, 0, 0, 0, 50, 50, 1, 0, 50, 50, 0, 0, 0, 2],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['total', 'added', 'removed']);
    assert.deepEqual(column(frame, 'value'), [50, 0, 50]);
    assert.deepEqual(column(frame, 'valueRight'), [50, 50, 0]);
  });

  it('positions bars by the combined extent of both sides', () => {
    // A diff bar spans left + right ticks and *both* gaps advance the cursor.
    // Counting either side alone would put the child under the first root
    // instead of the second — the sides have different gaps here on purpose.
    const frame = diff(
      ['A', 'B', 'b1'],
      [
        [0, 30, 0, 0, 20, 0, 0, 5, 10, 0, 7, 40, 0, 1],
        [40, 5, 5, 25, 5, 5, 2],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['A', 'B', 'b1']);
    assert.deepEqual(column(frame, 'level'), [0, 0, 1]);
    assert.deepEqual(column(frame, 'value'), [30, 10, 5]);
    assert.deepEqual(column(frame, 'valueRight'), [20, 40, 5]);
  });

  it('skips bars that are empty on both sides', () => {
    const frame = diff(
      ['total', 'gone'],
      [
        [0, 50, 0, 0, 50, 0, 0],
        [0, 0, 0, 0, 0, 0, 1],
      ],
    );
    assert.deepEqual(column(frame, 'label'), ['total']);
  });

  it('ignores a trailing partial bar', () => {
    const frame = diff(['total', 'x'], [[0, 50, 0, 0, 50, 0, 0, 0, 10]]);
    assert.deepEqual(column(frame, 'label'), ['total']);
  });

  it('returns undefined when there is nothing to draw', () => {
    assert.equal(diff([], []), undefined);
    assert.equal(diff(['total'], [[0, 0, 0, 0, 0, 0, 0]]), undefined);
  });
});
