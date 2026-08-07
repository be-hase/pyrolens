// Decodes Pyroscope's flamebearer wire format into the columnar DataFrame
// consumed by the flame graph component.
//
// Wire format: one flat array per depth. Plain profiles pack four numbers
// per bar — gap, width, own time, name index — while diff profiles pack
// seven strings (gap/width/own for each side, then the name index) and a
// bar's on-screen extent is the sum of both sides. A gap is measured from
// where the previous bar in the same row ended, so absolute positions are
// recovered by accumulating gap + width across the row.

import { FieldType, type DataFrame, type Field } from '@lib/flamegraph';
import type { DiffFlamegraphData, FlamegraphData } from '@api/client';

/** Flame graph display units per profile unit ('count' falls back). */
const GRAFANA_UNIT: Record<string, string> = { ns: 'ns', bytes: 'bytes' };

export function grafanaUnit(profileUnit: string): string {
  return GRAFANA_UNIT[profileUnit] ?? 'short';
}

/** One decoded bar. `cols` holds its output-column values in field order. */
interface Bar {
  x: number;
  span: number;
  label: string;
  cols: number[];
}

const SINGLE_COLUMNS = ['value', 'self'];
const DIFF_COLUMNS = ['value', 'self', 'valueRight', 'selfRight'];

function decodeSingleRow(names: string[], packed: number[]): Bar[] {
  const row: Bar[] = [];
  let x = 0;
  for (let at = 0; at + 4 <= packed.length; at += 4) {
    const [gap, width, own, nameIdx] = [
      packed[at],
      packed[at + 1],
      packed[at + 2],
      packed[at + 3],
    ];
    x += gap;
    if (width > 0) {
      row.push({
        x,
        span: width,
        label: names[nameIdx] ?? '',
        cols: [width, own],
      });
    }
    x += width;
  }
  return row;
}

function decodeDiffRow(names: string[], packed: string[]): Bar[] {
  const row: Bar[] = [];
  let x = 0;
  for (let at = 0; at + 7 <= packed.length; at += 7) {
    const n = (k: number) => Number(packed[at + k]);
    // Geometry lives in combined (left + right) ticks.
    x += n(0) + n(3);
    const leftWidth = n(1);
    const rightWidth = n(4);
    const span = leftWidth + rightWidth;
    if (span > 0) {
      row.push({
        x,
        span,
        label: names[n(6)] ?? '',
        cols: [leftWidth, n(2), rightWidth, n(5)],
      });
    }
    x += span;
  }
  return row;
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
  rows: Bar[][],
  columnNames: string[],
  unit: string,
): DataFrame | undefined {
  const labels: string[] = [];
  const depths: number[] = [];
  const columns: number[][] = columnNames.map(() => []);
  const cursor = new Array<number>(rows.length).fill(0);

  const stack: Frame[] = [];
  if (rows.length > 0) {
    stack.push({ depth: 0, windowStart: 0, windowEnd: Infinity });
  }
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const row = rows[frame.depth];
    const i = cursor[frame.depth];
    if (i >= row.length || row[i].x >= frame.windowEnd) {
      stack.pop();
      continue;
    }
    cursor[frame.depth] = i + 1;
    const bar = row[i];
    if (bar.x < frame.windowStart) continue;
    labels.push(bar.label);
    depths.push(frame.depth);
    bar.cols.forEach((v, c) => columns[c].push(v));
    if (frame.depth + 1 < rows.length) {
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
    data.levels.map((packed) => decodeSingleRow(data.names, packed)),
    SINGLE_COLUMNS,
    unit,
  );
}

export function diffFlamebearerToDataFrame(
  data: DiffFlamegraphData,
  unit: string,
): DataFrame | undefined {
  return flatten(
    data.levels.map((level) => decodeDiffRow(data.names, level.values)),
    DIFF_COLUMNS,
    unit,
  );
}
