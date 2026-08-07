import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { diffColorBlindColors, diffDefaultColors } from '../FlameGraph/colors';
import { type FlameGraphDataContainer } from '../FlameGraph/dataTransform';
import { TOP_TABLE_COLUMN_WIDTH } from '../constants';
import { cx } from '../cx';
import { getDisplayProcessor, type DisplayProcessor } from '../format';
import { ColorSchemeDiff, type ColorScheme, type TableData } from '../types';
import { IconButton } from '../ui/IconButton';
import { escapeStringForRegex } from '../utils';
import './FlameGraphTopTableContainer.css';

type Props = {
  data: FlameGraphDataContainer;
  onSymbolClick: (symbol: string) => void;
  // This is used for highlighting the search button in case there is exact match.
  search?: string;
  // We use these to filter out rows in the table if users is doing text search.
  matchedLabels?: Set<string>;
  sandwichItem?: string;
  onSearch: (str: string) => void;
  onSandwich: (str?: string) => void;
  onTableSort?: (sort: string) => void;
  colorScheme: ColorScheme | ColorSchemeDiff;
};

type ColumnId =
  'Symbol' | 'Self' | 'Total' | 'Baseline' | 'Comparison' | 'Diff';

type Column = {
  id: ColumnId;
  numeric: boolean;
  /** Fixed pixel width, symbol column takes the remaining space. */
  width?: number;
};

type TopTableRow = {
  symbol: string;
  self: number;
  total: number;
  // Only meaningful for a diff profile.
  baseline: number;
  comparison: number;
  diff: number;
};

type SortState = { displayName: ColumnId; desc: boolean };

const ACTION_COLUMN_WIDTH = 64;
const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const DEFAULT_VIEWPORT_HEIGHT = 600;

const COLUMNS: Column[] = [
  { id: 'Symbol', numeric: false },
  { id: 'Self', numeric: true, width: TOP_TABLE_COLUMN_WIDTH },
  { id: 'Total', numeric: true, width: TOP_TABLE_COLUMN_WIDTH },
];

const DIFF_COLUMNS: Column[] = [
  { id: 'Symbol', numeric: false },
  { id: 'Baseline', numeric: true, width: TOP_TABLE_COLUMN_WIDTH },
  { id: 'Comparison', numeric: true, width: TOP_TABLE_COLUMN_WIDTH },
  { id: 'Diff', numeric: true, width: TOP_TABLE_COLUMN_WIDTH },
];

const DEFAULT_SORT: SortState = { displayName: 'Self', desc: true };
const DEFAULT_DIFF_SORT: SortState = { displayName: 'Diff', desc: true };

const FlameGraphTopTableContainer = memo(
  ({
    data,
    onSymbolClick,
    search,
    matchedLabels,
    onSearch,
    sandwichItem,
    onSandwich,
    onTableSort,
    colorScheme,
  }: Props) => {
    const isDiff = data.isDiffFlamegraph();
    const columns = isDiff ? DIFF_COLUMNS : COLUMNS;

    const table = useMemo(
      () => buildFilteredTable(data, matchedLabels),
      [data, matchedLabels],
    );
    const rows = useMemo(() => buildTableRows(data, table), [data, table]);

    const selfDisplay = useMemo(
      () => getDisplayProcessor({ field: data.selfField }),
      [data],
    );
    const totalDisplay = useMemo(
      () => getDisplayProcessor({ field: data.valueField }),
      [data],
    );

    const [sort, setSort] = useState<SortState>(
      isDiff ? DEFAULT_DIFF_SORT : DEFAULT_SORT,
    );
    // The sorted column can disappear when we switch between a normal and a
    // diff profile, in that case fall back to the default for the mode.
    const activeSort = columns.some((c) => c.id === sort.displayName)
      ? sort
      : isDiff
        ? DEFAULT_DIFF_SORT
        : DEFAULT_SORT;

    // `activeSort` is either the state object or a module-level constant, so
    // its identity is stable between renders.
    const sortedRows = useMemo(
      () => sortRows(rows, activeSort),
      [rows, activeSort],
    );

    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(
      DEFAULT_VIEWPORT_HEIGHT,
    );

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const update = () =>
        setViewportHeight(el.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
      update();
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    const onSortClick = useCallback(
      (column: Column) => {
        setSort((current) => {
          const next: SortState =
            current.displayName === column.id
              ? { displayName: column.id, desc: !current.desc }
              : { displayName: column.id, desc: column.numeric };
          onTableSort?.(next.displayName + '_' + (next.desc ? 'desc' : 'asc'));
          return next;
        });
        scrollRef.current?.scrollTo({ top: 0 });
        setScrollTop(0);
      },
      [onTableSort],
    );

    // Only render the rows that can be on screen, the table can easily hold
    // thousands of symbols.
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      sortedRows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    const visibleRows = sortedRows.slice(start, end);
    const paddingTop = start * ROW_HEIGHT;
    const paddingBottom = (sortedRows.length - end) * ROW_HEIGHT;

    const [removeColor, addColor] =
      colorScheme === ColorSchemeDiff.DiffColorBlind
        ? [diffColorBlindColors[0], diffColorBlindColors[2]]
        : [diffDefaultColors[0], diffDefaultColors[2]];

    return (
      <div className="plfg-top-table" data-testid="topTable">
        <div
          className="plfg-top-table-scroll"
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <table className="plfg-top-table-table">
            <colgroup>
              <col style={{ width: ACTION_COLUMN_WIDTH }} />
              {columns.map((column) => (
                <col key={column.id} style={{ width: column.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="plfg-top-table-actions-header">
                  <span className="plfg-top-table-sr-only">Actions</span>
                </th>
                {columns.map((column) => {
                  const sorted = activeSort.displayName === column.id;
                  return (
                    <th
                      key={column.id}
                      className={cx(
                        column.numeric && 'plfg-top-table-numeric',
                        sorted && 'plfg-top-table-sorted',
                      )}
                      aria-sort={
                        sorted
                          ? activeSort.desc
                            ? 'descending'
                            : 'ascending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        className="plfg-top-table-sort-button"
                        onClick={() => onSortClick(column)}
                      >
                        <span>{column.id}</span>
                        {sorted && (
                          <span
                            className={cx(
                              'plfg-top-table-caret',
                              activeSort.desc && 'plfg-top-table-caret-desc',
                            )}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr
                  className="plfg-top-table-spacer"
                  aria-hidden="true"
                  style={{ height: paddingTop }}
                >
                  <td colSpan={columns.length + 1} />
                </tr>
              )}
              {visibleRows.map((row) => (
                <TopTableRowView
                  key={row.symbol}
                  row={row}
                  isDiff={isDiff}
                  search={search}
                  sandwichItem={sandwichItem}
                  onSearch={onSearch}
                  onSandwich={onSandwich}
                  onSymbolClick={onSymbolClick}
                  selfDisplay={selfDisplay}
                  totalDisplay={totalDisplay}
                  addColor={addColor}
                  removeColor={removeColor}
                />
              ))}
              {paddingBottom > 0 && (
                <tr
                  className="plfg-top-table-spacer"
                  aria-hidden="true"
                  style={{ height: paddingBottom }}
                >
                  <td colSpan={columns.length + 1} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
);

FlameGraphTopTableContainer.displayName = 'FlameGraphTopTableContainer';

type RowProps = {
  row: TopTableRow;
  isDiff: boolean;
  search?: string;
  sandwichItem?: string;
  onSearch: (str: string) => void;
  onSandwich: (str?: string) => void;
  onSymbolClick: (symbol: string) => void;
  selfDisplay: DisplayProcessor;
  totalDisplay: DisplayProcessor;
  addColor: string;
  removeColor: string;
};

function TopTableRowView({
  row,
  isDiff,
  search,
  sandwichItem,
  onSearch,
  onSandwich,
  onSymbolClick,
  selfDisplay,
  totalDisplay,
  addColor,
  removeColor,
}: RowProps) {
  const isSearched = search === `^${escapeStringForRegex(row.symbol)}$`;
  const isSandwiched = sandwichItem === row.symbol;

  return (
    <tr>
      <td className="plfg-top-table-actions">
        <div className="plfg-top-table-actions-wrapper">
          <IconButton
            name="sandwich"
            variant={isSandwiched ? 'primary' : 'secondary'}
            tooltip={
              isSandwiched
                ? 'Remove from sandwich view'
                : 'Show in sandwich view'
            }
            onClick={() => onSandwich(isSandwiched ? undefined : row.symbol)}
          />
          <IconButton
            name="search"
            variant={isSearched ? 'primary' : 'secondary'}
            tooltip={
              isSearched ? 'Clear from search' : 'Search for this symbol'
            }
            onClick={() => onSearch(isSearched ? '' : row.symbol)}
          />
        </div>
      </td>
      <td className="plfg-top-table-symbol" title={row.symbol}>
        <button
          type="button"
          className="plfg-top-table-symbol-button"
          onClick={() => onSymbolClick(row.symbol)}
        >
          {row.symbol}
        </button>
      </td>
      {isDiff ? (
        <>
          <td className="plfg-top-table-numeric">
            {formatPercent(row.baseline)}
          </td>
          <td className="plfg-top-table-numeric">
            {formatPercent(row.comparison)}
          </td>
          <td
            className="plfg-top-table-numeric"
            style={{ color: diffColor(row.diff, addColor, removeColor) }}
          >
            {formatDiff(row.diff)}
          </td>
        </>
      ) : (
        <>
          <td className="plfg-top-table-numeric">
            {formatValue(selfDisplay, row.self)}
          </td>
          <td className="plfg-top-table-numeric">
            {formatValue(totalDisplay, row.total)}
          </td>
        </>
      )}
    </tr>
  );
}

function formatValue(display: DisplayProcessor, value: number): string {
  const displayValue = display(value);
  return displayValue.text + (displayValue.suffix ?? '');
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  return `${value.toFixed(2)}%`;
}

function formatDiff(value: number): string {
  if (value === Infinity) {
    return 'new';
  }
  if (value === -100) {
    return 'removed';
  }
  if (!Number.isFinite(value)) {
    return '';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function diffColor(
  value: number,
  addColor: string,
  removeColor: string,
): string | undefined {
  if (Number.isNaN(value) || value === 0) {
    return undefined;
  }
  return value > 0 ? addColor : removeColor;
}

function sortRows(rows: TopTableRow[], sort: SortState): TopTableRow[] {
  const sorted = [...rows];
  const direction = sort.desc ? -1 : 1;

  if (sort.displayName === 'Symbol') {
    sorted.sort((a, b) => direction * a.symbol.localeCompare(b.symbol));
    return sorted;
  }

  const key = sortKey(sort.displayName);
  sorted.sort((a, b) => {
    // Compared instead of subtracted, the diff column can hold Infinity.
    const left = numericValue(a[key]);
    const right = numericValue(b[key]);
    if (left === right) {
      return 0;
    }
    return direction * (left < right ? -1 : 1);
  });
  return sorted;
}

function sortKey(column: ColumnId): keyof Omit<TopTableRow, 'symbol'> {
  switch (column) {
    case 'Total':
      return 'total';
    case 'Baseline':
      return 'baseline';
    case 'Comparison':
      return 'comparison';
    case 'Diff':
      return 'diff';
    default:
      return 'self';
  }
}

// NaN rows (a symbol with no samples on either side) sort to the bottom of a
// descending sort instead of scrambling the order.
function numericValue(value: number): number {
  return Number.isNaN(value) ? -Infinity : value;
}

function buildFilteredTable(
  data: FlameGraphDataContainer,
  matchedLabels?: Set<string>,
) {
  // Group the data by label, we show only one row per label and sum the values
  // TODO: should be by filename + funcName + linenumber?
  const filteredTable: { [key: string]: TableData } = Object.create(null);

  // Track call stack to detect recursive calls
  const callStack: string[] = [];

  for (let i = 0; i < data.data.length; i++) {
    const value = data.getValue(i);
    const valueRight = data.getValueRight(i);
    const self = data.getSelf(i);
    const label = data.getLabel(i);
    const level = data.getLevel(i);

    // Maintain call stack based on level changes
    while (callStack.length > level) {
      callStack.pop();
    }

    // Check if this is a recursive call (same label already in call stack)
    const isRecursive = callStack.some((entry) => entry === label);

    // If user is doing text search we filter out labels in the same way we highlight them in flame graph.
    if (!matchedLabels || matchedLabels.has(label)) {
      const entry: TableData = filteredTable[label] ?? {
        self: 0,
        total: 0,
        totalRight: 0,
      };
      entry.self += self;

      // Only add to total if this is not a recursive call
      if (!isRecursive) {
        entry.total += value;
        entry.totalRight += valueRight;
      }
      filteredTable[label] = entry;
    }

    // Add current call to the stack
    callStack.push(label);
  }

  return filteredTable;
}

function buildTableRows(
  data: FlameGraphDataContainer,
  table: { [key: string]: TableData },
): TopTableRow[] {
  const rows: TopTableRow[] = [];

  if (data.isDiffFlamegraph()) {
    // For this we don't really consider sandwich view even though you can switch it on.
    const levels = data.getLevels();
    const totalTicks = levels.length ? levels[0][0].value : 0;
    const totalTicksRight = levels.length ? levels[0][0].valueRight : undefined;

    for (const key in table) {
      const ticksLeft = table[key].total;
      const ticksRight = table[key].totalRight;

      // We are iterating over table of the data so totalTicksRight needs to be defined
      const totalTicksLeft = totalTicks - totalTicksRight!;

      const percentageLeft =
        Math.round((10000 * ticksLeft) / totalTicksLeft) / 100;
      const percentageRight =
        Math.round((10000 * ticksRight) / totalTicksRight!) / 100;

      const diff = ((percentageRight - percentageLeft) / percentageLeft) * 100;

      rows.push({
        symbol: key,
        self: table[key].self,
        total: ticksLeft,
        baseline: percentageLeft,
        comparison: percentageRight,
        diff,
      });
    }

    return rows;
  }

  for (const key in table) {
    rows.push({
      symbol: key,
      self: table[key].self,
      total: table[key].total,
      baseline: 0,
      comparison: 0,
      diff: 0,
    });
  }

  return rows;
}

export default FlameGraphTopTableContainer;
