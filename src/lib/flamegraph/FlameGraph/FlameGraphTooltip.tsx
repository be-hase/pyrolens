import {
  type DisplayValue,
  getValueFormat,
  groupThousands,
  type ValueFormatter,
} from '../format';
import { Portal } from '../ui/Portal';
import { TooltipContainer } from '../ui/TooltipContainer';

import {
  type CollapseConfig,
  type FlameGraphDataContainer,
  type LevelItem,
} from './dataTransform';

import './FlameGraphTooltip.css';

type Props = {
  data: FlameGraphDataContainer;
  totalTicks: number;
  position?: { x: number; y: number };
  item?: LevelItem;
  collapseConfig?: CollapseConfig;
};

const FlameGraphTooltip = ({
  data,
  item,
  totalTicks,
  position,
  collapseConfig,
}: Props) => {
  if (!(item && position)) {
    return null;
  }

  let content;

  if (data.isDiffFlamegraph()) {
    const tableData = getDiffTooltipData(data, item, totalTicks);
    content = (
      <table className="plfg-tooltip-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Baseline</th>
            <th scope="col">Comparison</th>
            <th scope="col">Diff</th>
          </tr>
        </thead>
        <tbody>
          {tableData.map((row) => (
            <tr key={row.rowId}>
              <th scope="row">{row.label}</th>
              <td>{row.baseline}</td>
              <td>{row.comparison}</td>
              <td>{row.diff}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    const tooltipData = getTooltipData(data, item, totalTicks);
    content = (
      <p className="plfg-tooltip-last-paragraph">
        {tooltipData.unitTitle}
        <br />
        Total: <b>{tooltipData.unitValue}</b> ({tooltipData.percentValue}%)
        <br />
        Self: <b>{tooltipData.unitSelf}</b> ({tooltipData.percentSelf}%)
        <br />
        Samples: <b>{tooltipData.samples}</b>
      </p>
    );
  }

  return (
    <Portal>
      <TooltipContainer position={position} offset={{ x: 15, y: 0 }}>
        <div className="plfg-tooltip-content">
          <p className="plfg-tooltip-name">
            {data.getLabel(item.itemIndexes[0])}
            {collapseConfig && collapseConfig.collapsed ? (
              <span>
                <br />
                and {collapseConfig.items.length} similar items
              </span>
            ) : (
              ''
            )}
          </p>
          {content}
        </div>
      </TooltipContainer>
    </Portal>
  );
};

type TooltipData = {
  percentValue: number;
  percentSelf: number;
  unitTitle: string;
  unitValue: string;
  unitSelf: string;
  samples: string;
};

export const getTooltipData = (
  data: FlameGraphDataContainer,
  item: LevelItem,
  totalTicks: number,
): TooltipData => {
  const displayValue = data.valueDisplayProcessor(item.value);
  const displaySelf = data.getSelfDisplay(item.itemIndexes);

  const percentValue =
    Math.round(10000 * (displayValue.numeric / totalTicks)) / 100;
  const percentSelf =
    Math.round(10000 * (displaySelf.numeric / totalTicks)) / 100;
  let unitValue = displayValue.text + displayValue.suffix;
  let unitSelf = displaySelf.text + displaySelf.suffix;

  const unitTitle = data.getUnitTitle();
  if (unitTitle === 'Count') {
    if (!displayValue.suffix) {
      // Makes sure we don't show 123undefined or something like that if suffix isn't defined
      unitValue = displayValue.text;
    }
    if (!displaySelf.suffix) {
      // Makes sure we don't show 123undefined or something like that if suffix isn't defined
      unitSelf = displaySelf.text;
    }
  }

  return {
    percentValue,
    percentSelf,
    unitTitle,
    unitValue,
    unitSelf,
    samples: groupThousands(displayValue.numeric),
  };
};

type DiffTableData = {
  rowId: string;
  label: string;
  baseline: string | number;
  comparison: string | number;
  diff: string | number;
};

const formatWithSuffix = (value: number, formatter: ValueFormatter): string => {
  const displayValue = formatter(value);
  return displayValue.text + displayValue.suffix;
};

export const getDiffTooltipData = (
  data: FlameGraphDataContainer,
  item: LevelItem,
  totalTicks: number,
): DiffTableData[] => {
  const levels = data.getLevels();
  const totalTicksRight = levels[0][0].valueRight!;
  const totalTicksLeft = totalTicks - totalTicksRight;
  const valueLeft = item.value - item.valueRight!;

  // Deviates from upstream: upstream divides by totalTicksLeft/totalTicksRight
  // unconditionally, which is NaN when that side of the diff interval has no
  // samples at all (e.g. an empty baseline time range). A percentage over a
  // zero total is defined as 0 instead.
  const percentageLeft =
    totalTicksLeft === 0
      ? 0
      : Math.round((10000 * valueLeft) / totalTicksLeft) / 100;
  const percentageRight =
    totalTicksRight === 0
      ? 0
      : Math.round((10000 * item.valueRight!) / totalTicksRight) / 100;

  // Deviates from upstream: upstream computes
  // ((percentageRight - percentageLeft) / percentageLeft) * 100 unconditionally,
  // which divides by zero whenever the baseline percentage is 0. Two zero
  // percentages is a real, well-defined 0 diff; a zero baseline against a
  // nonzero comparison has no defined percent change, so that case is left
  // undefined here and rendered as 'n/a' below instead of "Infinity%".
  const diffDefined = !(percentageLeft === 0 && percentageRight !== 0);
  const diff =
    percentageLeft === 0
      ? 0
      : ((percentageRight - percentageLeft) / percentageLeft) * 100;

  const displayValueLeft = getValueWithUnit(
    data,
    data.valueDisplayProcessor(valueLeft),
  );
  const displayValueRight = getValueWithUnit(
    data,
    data.valueDisplayProcessor(item.valueRight!),
  );

  const shortValFormat = getValueFormat('short');

  return [
    {
      rowId: '1',
      label: '% of total',
      baseline: percentageLeft + '%',
      comparison: percentageRight + '%',
      diff: diffDefined ? formatWithSuffix(diff, shortValFormat) + '%' : 'n/a',
    },
    {
      rowId: '2',
      label: 'Value',
      baseline: displayValueLeft,
      comparison: displayValueRight,
      diff: getValueWithUnit(
        data,
        data.valueDisplayProcessor(item.valueRight! - valueLeft),
      ),
    },
    {
      rowId: '3',
      label: 'Samples',
      baseline: formatWithSuffix(valueLeft, shortValFormat),
      comparison: formatWithSuffix(item.valueRight!, shortValFormat),
      diff: formatWithSuffix(item.valueRight! - valueLeft, shortValFormat),
    },
  ];
};

function getValueWithUnit(
  data: FlameGraphDataContainer,
  displayValue: DisplayValue,
) {
  let unitValue = displayValue.text + displayValue.suffix;

  const unitTitle = data.getUnitTitle();
  if (unitTitle === 'Count') {
    if (!displayValue.suffix) {
      // Makes sure we don't show 123undefined or something like that if suffix isn't defined
      unitValue = displayValue.text;
    }
  }
  return unitValue;
}

export default FlameGraphTooltip;
