import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { type DataFrame, FieldType } from '../data.ts';
import { type Theme } from '../theme.ts';

import { FlameGraphDataContainer } from './dataTransform.ts';
import { getDiffTooltipData } from './FlameGraphTooltip.tsx';

// getDiffTooltipData is this project's own fix layered onto upstream's diff
// math (see VENDORED.md, zero-baseline diff guards): a one-sided diff — a
// baseline or comparison interval with no samples at all — used to divide by
// zero and render "NaN%"/"Infinity%" in the tooltip. Tested here rather than
// left to a screenshot.

// A theme that doesn't touch `document`, so this test has no DOM dependency.
const THEME: Theme = {
  isLight: false,
  colors: {
    background: { primary: '#000', secondary: '#000' },
    text: { primary: '#fff', secondary: '#fff', disabled: '#fff' },
  },
};

// A single-frame diff dataframe: `value`/`self` are the baseline (left) side,
// `valueRight`/`selfRight` the comparison (right) side.
function diffFrame(value: number, valueRight: number): DataFrame {
  return {
    length: 1,
    fields: [
      {
        name: 'label',
        type: FieldType.string,
        values: ['total'],
        config: {},
      },
      { name: 'level', type: FieldType.number, values: [0], config: {} },
      { name: 'value', type: FieldType.number, values: [value], config: {} },
      { name: 'self', type: FieldType.number, values: [value], config: {} },
      {
        name: 'valueRight',
        type: FieldType.number,
        values: [valueRight],
        config: {},
      },
      {
        name: 'selfRight',
        type: FieldType.number,
        values: [valueRight],
        config: {},
      },
    ],
  };
}

describe('getDiffTooltipData: zero-baseline guards', () => {
  it('renders a 0% baseline, not NaN%, when the baseline interval has no samples', () => {
    const container = new FlameGraphDataContainer(
      diffFrame(0, 100),
      { collapsing: false },
      THEME,
    );
    const root = container.getLevels()[0][0];
    const [percentRow] = getDiffTooltipData(container, root, root.value);

    assert.equal(percentRow.baseline, '0%');
    assert.equal(percentRow.comparison, '100%');
    // A zero baseline against a nonzero comparison has no defined percent
    // change; upstream would divide by zero here and render "Infinity%".
    assert.equal(percentRow.diff, 'n/a');
  });

  it('renders a 0% diff, not NaN%, when both sides have no samples', () => {
    const container = new FlameGraphDataContainer(
      diffFrame(0, 0),
      { collapsing: false },
      THEME,
    );
    const root = container.getLevels()[0][0];
    const [percentRow] = getDiffTooltipData(container, root, root.value);

    assert.equal(percentRow.baseline, '0%');
    assert.equal(percentRow.comparison, '0%');
    assert.equal(percentRow.diff, '0%');
  });

  it('still reports a defined -100% diff when only the comparison side is empty', () => {
    const container = new FlameGraphDataContainer(
      diffFrame(100, 0),
      { collapsing: false },
      THEME,
    );
    const root = container.getLevels()[0][0];
    const [percentRow] = getDiffTooltipData(container, root, root.value);

    assert.equal(percentRow.baseline, '100%');
    assert.equal(percentRow.comparison, '0%');
    assert.equal(percentRow.diff, '-100%');
  });
});
