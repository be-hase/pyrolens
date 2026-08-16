// Decodes Pyroscope's flamebearer wire format into the columnar DataFrame
// consumed by the flame graph component.
//
// Wire format: one flat array per depth. Plain profiles pack four numbers
// per bar — gap, width, own time, name index — while diff profiles pack
// seven strings (gap/width/own for each side, then the name index) and a
// bar's on-screen extent is the sum of both sides. A gap is measured from
// where the previous bar in the same row ended, so absolute positions are
// recovered by accumulating gap + width across the row.
//
// Decoding writes straight into the output column arrays instead of first
// building a Bar-per-frame object graph and copying it over: on a wide,
// deep profile that graph is tens of thousands of small objects the GC has
// to chase for no reason, all alive at once alongside the columns they're
// about to be copied into. That is a real win for plain (single) profiles,
// which are already numbers. Diff profiles arrive as strings and still pay
// for a `Number()` per field either way, so skipping the object graph there
// only measures as a modest improvement — most of diff decoding's cost is
// the string coercion, not the allocation this refactor removes.

import { FieldType, type DataFrame, type Field } from '@lib/flamegraph';
import type { DiffFlamegraphData, FlamegraphData } from '@api/client';

/** Flame graph display units per profile unit ('count' falls back). */
const GRAFANA_UNIT: Record<string, string> = { ns: 'ns', bytes: 'bytes' };

export function grafanaUnit(profileUnit: string): string {
  return GRAFANA_UNIT[profileUnit] ?? 'short';
}

/**
 * The next undropped bar in a row, decoded on demand. `cols` is a
 * fixed-size scratch array owned by the cursor: it is overwritten on every
 * `peek()` that advances, so a caller must copy the values out (as `flatten`
 * does, into the output columns) before asking the cursor for another bar.
 */
interface CursorBar {
  x: number;
  span: number;
  label: string;
  cols: number[];
}

/**
 * Sequential, one-bar-at-a-time view over a single packed row. `peek()` is
 * idempotent — it decodes the next non-empty bar and caches it until
 * `consume()` is called — because `flatten` below needs to inspect a bar's
 * position against more than one candidate parent window before deciding
 * whether it belongs to the current one.
 */
interface RowCursor {
  peek(): CursorBar | undefined;
  consume(): void;
}

const SINGLE_COLUMNS = ['value', 'self'];
const DIFF_COLUMNS = ['value', 'self', 'valueRight', 'selfRight'];

function makeSingleRowCursor(names: string[], packed: number[]): RowCursor {
  let at = 0;
  let x = 0;
  let cached = false;
  let exhausted = false;
  const cols = [0, 0];
  const bar: CursorBar = { x: 0, span: 0, label: '', cols };

  // Scans forward from `at`, skipping zero-width bars, until it lands on
  // one worth emitting or runs out of whole groups of four.
  function decodeNext(): boolean {
    while (at + 4 <= packed.length) {
      const gap = packed[at];
      const width = packed[at + 1];
      const own = packed[at + 2];
      const nameIdx = packed[at + 3];
      at += 4;
      x += gap;
      const barX = x;
      x += width;
      if (width > 0) {
        bar.x = barX;
        bar.span = width;
        bar.label = names[nameIdx] ?? '';
        cols[0] = width;
        cols[1] = own;
        return true;
      }
    }
    return false;
  }

  return {
    peek() {
      if (exhausted) return undefined;
      if (!cached) {
        cached = decodeNext();
        if (!cached) {
          exhausted = true;
          return undefined;
        }
      }
      return bar;
    },
    consume() {
      cached = false;
    },
  };
}

function makeDiffRowCursor(names: string[], packed: string[]): RowCursor {
  let at = 0;
  let x = 0;
  let cached = false;
  let exhausted = false;
  const cols = [0, 0, 0, 0];
  const bar: CursorBar = { x: 0, span: 0, label: '', cols };

  function decodeNext(): boolean {
    while (at + 7 <= packed.length) {
      // Inline reads rather than a per-bar `(k) => Number(packed[at + k])`
      // closure, matching the single path's style and avoiding a function
      // allocation for every bar.
      const leftGap = Number(packed[at]);
      const leftWidth = Number(packed[at + 1]);
      const leftOwn = Number(packed[at + 2]);
      const rightGap = Number(packed[at + 3]);
      const rightWidth = Number(packed[at + 4]);
      const rightOwn = Number(packed[at + 5]);
      const nameIdx = Number(packed[at + 6]);
      at += 7;
      // Geometry lives in combined (left + right) ticks.
      x += leftGap + rightGap;
      const barX = x;
      const span = leftWidth + rightWidth;
      x += span;
      if (span > 0) {
        bar.x = barX;
        bar.span = span;
        bar.label = names[nameIdx] ?? '';
        cols[0] = leftWidth;
        cols[1] = leftOwn;
        cols[2] = rightWidth;
        cols[3] = rightOwn;
        return true;
      }
    }
    return false;
  }

  return {
    peek() {
      if (exhausted) return undefined;
      if (!cached) {
        cached = decodeNext();
        if (!cached) {
          exhausted = true;
          return undefined;
        }
      }
      return bar;
    },
    consume() {
      cached = false;
    },
  };
}

// Depth-first flattening without building a tree: each row is already
// ordered by position and the traversal sweeps left to right, so a single
// cursor per row identifies every bar's place. A bar is a child of the
// enclosing window; bars left of the window are malformed input and are
// dropped. Uses an explicit stack rather than recursion, so profiles deeper
// than the JS call-stack limit (thousands of frames) don't overflow.
interface Frame {
  depth: number;
  windowStart: number;
  windowEnd: number;
}

function flatten(
  cursors: RowCursor[],
  columnNames: string[],
  unit: string,
): DataFrame | undefined {
  const labels: string[] = [];
  const depths: number[] = [];
  const columns: number[][] = columnNames.map(() => []);

  const stack: Frame[] = [];
  if (cursors.length > 0) {
    stack.push({ depth: 0, windowStart: 0, windowEnd: Infinity });
  }
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const cursor = cursors[frame.depth];
    const bar = cursor.peek();
    if (bar === undefined || bar.x >= frame.windowEnd) {
      stack.pop();
      continue;
    }
    cursor.consume();
    if (bar.x < frame.windowStart) continue;
    labels.push(bar.label);
    depths.push(frame.depth);
    for (let c = 0; c < bar.cols.length; c++) columns[c].push(bar.cols[c]);
    if (frame.depth + 1 < cursors.length) {
      // Push the child window; LIFO order visits it before this frame's
      // next sibling, preserving the recursive DFS emit order.
      stack.push({
        depth: frame.depth + 1,
        windowStart: bar.x,
        windowEnd: bar.x + bar.span,
      });
    }
  }

  if (labels.length === 0) return undefined;

  const fields: Field[] = [
    { name: 'label', values: labels, type: FieldType.string, config: {} },
    { name: 'level', values: depths, type: FieldType.number, config: {} },
    ...columnNames.map((name, c) => ({
      name,
      values: columns[c],
      type: FieldType.number,
      config: { unit },
    })),
  ];
  return { fields, length: labels.length };
}

export function flamebearerToDataFrame(
  data: FlamegraphData,
  unit: string,
): DataFrame | undefined {
  return flatten(
    data.levels.map((packed) => makeSingleRowCursor(data.names, packed)),
    SINGLE_COLUMNS,
    unit,
  );
}

export function diffFlamebearerToDataFrame(
  data: DiffFlamegraphData,
  unit: string,
): DataFrame | undefined {
  return flatten(
    data.levels.map((level) => makeDiffRowCursor(data.names, level.values)),
    DIFF_COLUMNS,
    unit,
  );
}
