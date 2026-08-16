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

/**
 * Maps single-format packed rows onto the diff wire shape by putting every
 * bar on the left side and zeroing the right. Lets one fixture pin both
 * decoders: diff's label/level/value/self columns should come out identical
 * to single's, with valueRight/selfRight all zero.
 */
function toDiffLevels(levels: number[][]): { values: string[] }[] {
  return levels.map((row) => {
    const values: string[] = [];
    for (let at = 0; at + 4 <= row.length; at += 4) {
      values.push(
        String(row[at]),
        String(row[at + 1]),
        String(row[at + 2]),
        '0',
        '0',
        '0',
        String(row[at + 3]),
      );
    }
    return { values };
  });
}

/** Small deterministic PRNG (mulberry32) so the fixture below is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TreeNode {
  label: string;
  level: number;
  value: number;
  self: number;
  children: TreeNode[];
}

/**
 * A random-ish, but never overflowing, wire fixture: each parent hands its
 * children a width budget carved out of its own width and never exceeds it,
 * so the tree is well-formed by construction — every child's on-screen span
 * fits inside its parent's. Building it as an explicit tree, not just the
 * flat packed rows, means the exact decoded emission can be computed
 * independently of `flatten()` and compared against its actual output,
 * rather than only checking properties a wrong emission could still satisfy.
 */
function randomTree(seed: number, levels: number, maxChildren: number) {
  const rand = mulberry32(seed);
  const rootWidth = 4000;
  const root: TreeNode = {
    label: 'n',
    level: 0,
    value: rootWidth,
    self: 0,
    children: [],
  };
  const packedLevels: number[][] = [[0, rootWidth, 0, 0]];
  let parents = [{ x: 0, width: rootWidth, node: root }];

  for (let depth = 1; depth < levels && parents.length > 0; depth++) {
    const row: number[] = [];
    const nextParents: { x: number; width: number; node: TreeNode }[] = [];
    let rowEnd = 0;
    for (const parent of parents) {
      const childCount = Math.floor(rand() * (maxChildren + 1));
      let budget = parent.width;
      let x = parent.x;
      for (let c = 0; c < childCount && budget > 1; c++) {
        const remainingSlots = childCount - c;
        const maxWidth = Math.max(1, Math.floor(budget / remainingSlots));
        const width = 1 + Math.floor(rand() * maxWidth);
        const own = Math.floor(rand() * width);
        row.push(x - rowEnd, width, own, 0);
        rowEnd = x + width;
        const node: TreeNode = {
          label: 'n',
          level: depth,
          value: width,
          self: own,
          children: [],
        };
        parent.node.children.push(node);
        nextParents.push({ x, width, node });
        x += width;
        budget -= width;
      }
    }
    packedLevels.push(row);
    parents = nextParents;
  }

  // Flatten the tree into the exact depth-first order `flatten()` emits — a
  // node, then its children left to right — via an explicit stack, the same
  // discipline the decoder itself uses.
  const labels: string[] = [];
  const levelsOut: number[] = [];
  const values: number[] = [];
  const selfs: number[] = [];
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break; // unreachable; narrows the type
    labels.push(node.label);
    levelsOut.push(node.level);
    values.push(node.value);
    selfs.push(node.self);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }

  return {
    names: ['n'],
    levels: packedLevels,
    expected: { labels, levels: levelsOut, values, selfs },
  };
}

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

  it('decodes a profile that is both deep and wide (~10k frames)', () => {
    // Depth alone (above) and width alone (above) each pin the no-recursion
    // invariant in isolation; a real profile stresses both at once. Each
    // level is one bar that keeps a chain going (wide enough to carry the
    // next level's fan-out) plus a handful of leaf siblings that stop there
    // — shrinking the chain bar by exactly the leaves' width each level, so
    // every level's bars fit tightly inside its parent's span.
    const childrenPerLevel = 20; // 1 "chain" bar + this many leaf siblings
    const levelCount = 500;
    const leaves = childrenPerLevel - 1;
    const rootWidth = levelCount * leaves + 1;

    const names = ['root', 'chain', 'leaf'];
    const levels: number[][] = [[0, rootWidth, 0, 0]];
    let chainWidth = rootWidth;
    for (let i = 0; i < levelCount; i++) {
      const nextChainWidth = chainWidth - leaves;
      const row: number[] = [0, nextChainWidth, 1, 1]; // the chain bar
      for (let j = 0; j < leaves; j++) row.push(0, 1, 1, 2); // leaf siblings
      levels.push(row);
      chainWidth = nextChainWidth;
    }

    const frame = single(names, levels);
    const totalFrames = 1 + levelCount * childrenPerLevel;
    assert.equal(frame?.length, totalFrames);

    const label = column(frame, 'label');
    const level = column(frame, 'level');
    const value = column(frame, 'value');
    assert.equal(Math.max(...(level ?? [])), levelCount);
    // The root and the full chain are emitted first, depth-first.
    assert.equal(label?.[0], 'root');
    assert.equal(value?.[0], rootWidth);
    assert.equal(label?.[1], 'chain');
    assert.equal(value?.[1], rootWidth - leaves);
    assert.equal(label?.[levelCount], 'chain');
    assert.equal(value?.[levelCount], 1); // the last chain bar's own width
    // Every level (chain + its leaves) contributes exactly childrenPerLevel
    // frames, except the root's own level.
    for (let lvl = 1; lvl <= levelCount; lvl++) {
      const count = (level ?? []).filter((v) => v === lvl).length;
      assert.equal(count, childrenPerLevel);
    }
    // The chain bottoms out, then leaves unwind from the deepest level back
    // to the shallowest, so the very last frame emitted is a level-1 leaf.
    assert.equal(label?.at(-1), 'leaf');
    assert.equal(level?.at(-1), 1);
    assert.equal(value?.at(-1), 1);

    // The same shape, decoded as a diff profile with everything on the left
    // and zero on the right, must land on the identical label/level/value
    // columns — this pins the diff cursor's own gap accumulation and the
    // shared traversal at the same depth and width as the single-mode check
    // above, which the diff decoder was not otherwise exercised at.
    const diffFrame = diffFlamebearerToDataFrame(
      { names, levels: toDiffLevels(levels) },
      'ns',
    );
    assert.deepEqual(column(diffFrame, 'label'), label);
    assert.deepEqual(column(diffFrame, 'level'), level);
    assert.deepEqual(column(diffFrame, 'value'), value);
    assert.deepEqual(column(diffFrame, 'self'), column(frame, 'self'));
    const zeros = (value ?? []).map(() => 0);
    assert.deepEqual(column(diffFrame, 'valueRight'), zeros);
    assert.deepEqual(column(diffFrame, 'selfRight'), zeros);
  });

  it('matches the exact decoded emission for a random well-formed tree, in both modes', () => {
    // Structural checks (depth bound, children-within-budget) can still pass
    // on a badly wrong emission — dropped or duplicated frames, a reordered
    // subtree — as long as each individual node still looks locally sane.
    // Comparing against the label/level/value/self sequence computed
    // independently while building the fixture catches that class of bug
    // directly; the same fixture mapped through `toDiffLevels` pins the diff
    // decoder against the identical ground truth.
    for (const seed of [1, 2, 3]) {
      const { names, levels, expected } = randomTree(seed, 7, 4);
      assert.ok(expected.labels.length > 3); // actually exercised several levels

      const frame = single(names, levels);
      assert.deepEqual(column(frame, 'label'), expected.labels);
      assert.deepEqual(column(frame, 'level'), expected.levels);
      assert.deepEqual(column(frame, 'value'), expected.values);
      assert.deepEqual(column(frame, 'self'), expected.selfs);

      const diffFrame = diffFlamebearerToDataFrame(
        { names, levels: toDiffLevels(levels) },
        'ns',
      );
      assert.deepEqual(column(diffFrame, 'label'), expected.labels);
      assert.deepEqual(column(diffFrame, 'level'), expected.levels);
      assert.deepEqual(column(diffFrame, 'value'), expected.values);
      assert.deepEqual(column(diffFrame, 'self'), expected.selfs);
      const zeros = expected.values.map(() => 0);
      assert.deepEqual(column(diffFrame, 'valueRight'), zeros);
      assert.deepEqual(column(diffFrame, 'selfRight'), zeros);
    }
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

  it('refreshes every column on each bar, not just the first', () => {
    // The decoder reuses one scratch array across bars in a row. A bug that
    // reassigns cols[0]/cols[2] (value/valueRight) but not cols[1]/cols[3]
    // (self/selfRight) on the second bar would still pass every other case
    // here, since none of them varies self/selfRight between siblings. These
    // two do, in all four slots.
    const frame = diff(
      ['a', 'b'],
      [[0, 10, 1, 0, 20, 2, 0, 0, 30, 3, 0, 40, 4, 1]],
    );
    assert.deepEqual(column(frame, 'label'), ['a', 'b']);
    assert.deepEqual(column(frame, 'level'), [0, 0]);
    assert.deepEqual(column(frame, 'value'), [10, 30]);
    assert.deepEqual(column(frame, 'self'), [1, 3]);
    assert.deepEqual(column(frame, 'valueRight'), [20, 40]);
    assert.deepEqual(column(frame, 'selfRight'), [2, 4]);
  });
});
