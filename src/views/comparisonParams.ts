import { resolveTime, type TimeRange } from '../time';
import { useRoute } from '../urlState';

export interface PaneParams {
  /** URL param prefix: "left" or "right". */
  side: 'left' | 'right';
  query: string;
  range: TimeRange;
}

// Left/right pane state for the Comparison and Diff views. Everything lives in
// URL params (leftQuery, leftFrom, leftUntil, rightQuery, ...), mirroring the
// classic Pyroscope UI. Defaults: both panes inherit the main query; the left
// pane covers the first half of the main range, the right pane the second.
export function useComparisonParams(
  mainQuery: string,
  mainRange: TimeRange,
): { left: PaneParams; right: PaneParams } {
  const { params } = useRoute();
  const mid = Math.round((mainRange.start + mainRange.end) / 2);
  const now = mainRange.end;

  const pane = (
    side: 'left' | 'right',
    defStart: number,
    defEnd: number,
  ): PaneParams => {
    const start = resolveTime(params.get(`${side}From`), defStart, now);
    const end = resolveTime(params.get(`${side}Until`), defEnd, now);
    return {
      side,
      query: params.get(`${side}Query`) ?? mainQuery,
      range: start < end ? { start, end } : { start: defStart, end: defEnd },
    };
  };

  return {
    left: pane('left', mainRange.start, mid),
    right: pane('right', mid, mainRange.end),
  };
}
