import { isRelative, resolveTime, type TimeRange } from '../time';
import { useRoute } from '../urlState';

export interface PaneParams {
  /** URL param prefix: "left" or "right". */
  side: 'left' | 'right';
  query: string;
  range: TimeRange;
  /** Raw `<side>Query` URL value, null when absent. Unlike `query`, this is
   * not resolved against the main query — it is what distinguishes "this
   * pane explicitly overrides the query" from "this pane inherits it",
   * which `swappedPaneParams` needs to swap correctly. */
  queryOverride: string | null;
  /** Raw `<side>From` / `<side>Until` URL values, null when absent. Same
   * reasoning as `queryOverride`, for the pane's bounds. */
  fromOverride: string | null;
  untilOverride: string | null;
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
    const queryOverride = params.get(`${side}Query`);
    const fromOverride = params.get(`${side}From`);
    const untilOverride = params.get(`${side}Until`);
    const start = resolveTime(fromOverride, defStart, now);
    const end = resolveTime(untilOverride, defEnd, now);
    return {
      side,
      query: queryOverride ?? mainQuery,
      range: start < end ? { start, end } : { start: defStart, end: defEnd },
      queryOverride,
      fromOverride,
      untilOverride,
    };
  };

  return {
    left: pane('left', mainRange.start, mid),
    right: pane('right', mid, mainRange.end),
  };
}

// Params for the Single view's "Compare vs previous" / "Diff vs previous"
// actions: an equal-duration baseline immediately before `range`. Left is
// the previous period (baseline), right is the current one (comparison) —
// matching the Diff view's baseline/comparison orientation. The main
// from/until is widened to cover both windows so the pane timelines (which
// are brushed against the main range) can show the earlier window at all.
export function previousPeriodParams(
  query: string,
  from: string,
  until: string,
  range: TimeRange,
): Record<string, string | null> {
  // A relative main range ("now-1h") has to stay relative, or widening it
  // bakes the click's timestamp into the URL and auto-refresh (which only
  // ticks for a range still ending at "now") silently dies — and that frozen
  // absolute value then keeps riding along through every later navigation
  // that only touches other params. `from === 'now'` with no offset can't
  // occur as a range start (resolveRange always subtracts a default span
  // from a bare "now"), so only the "now-N<unit>" form needs handling; a
  // `from` that doesn't match it falls through to the absolute branch below.
  if (isRelative(from) && (until === 'now' || !until)) {
    const rel = from.match(/^now-(\d+)([smhdw])$/);
    if (rel) {
      // Doubling the offset in the same unit is exact — no unit-conversion
      // rounding the way going through milliseconds and back would risk.
      const doubled = `now-${Number(rel[1]) * 2}${rel[2]}`;
      return {
        from: doubled,
        until: null,
        leftQuery: query,
        rightQuery: query,
        leftFrom: doubled,
        leftUntil: from,
        rightFrom: from,
        rightUntil: 'now',
      };
    }
  }

  const span = range.end - range.start;
  const previousStart = range.start - span;
  return {
    from: String(previousStart),
    until: String(range.end),
    leftQuery: query,
    rightQuery: query,
    leftFrom: String(previousStart),
    leftUntil: String(range.start),
    rightFrom: String(range.start),
    rightUntil: String(range.end),
  };
}

// A pane's missing bound resolves to a different default half depending on
// which side it's on (left's absent `until` is the main midpoint, right's
// absent `from` is the same midpoint but *its* default, not left's) — so a
// null override can't cross sides verbatim without landing on the wrong
// default. This completes a side's window into an explicit {from, until}
// pair before it moves: an overridden bound keeps its raw string, an absent
// one is filled from that side's own resolved default, preferring a
// relative expression (so the swapped pane keeps sliding with "now" instead
// of freezing) when the main range is relative and the default divides into
// whole seconds.
function completedPaneWindow(
  side: 'left' | 'right',
  pane: PaneParams,
  isRelativeMain: boolean,
  mainSpan: number,
): { from: string; until: string } {
  const halfSeconds = mainSpan / 2 / 1000;
  const fullSeconds = mainSpan / 1000;
  // Left's default `from` is the main start (whole span from "now"); right's
  // default `from` is the midpoint (half span from "now").
  const relFrom =
    side === 'left'
      ? mainSpan % 1000 === 0
        ? `now-${fullSeconds}s`
        : null
      : mainSpan % 2000 === 0
        ? `now-${halfSeconds}s`
        : null;
  // Left's default `until` is the midpoint; right's default `until` is the
  // main end, i.e. exactly "now" (mainRange.end === now, see
  // useComparisonParams), so it's always expressible when the main range is
  // relative.
  const relUntil =
    side === 'left'
      ? mainSpan % 2000 === 0
        ? `now-${halfSeconds}s`
        : null
      : 'now';

  const from =
    pane.fromOverride ??
    (isRelativeMain && relFrom != null ? relFrom : String(pane.range.start));
  const until =
    pane.untilOverride ??
    (isRelativeMain && relUntil != null ? relUntil : String(pane.range.end));
  return { from, until };
}

// Params for the Comparison/Diff "Swap sides" action: exchanges the two
// panes' queries and windows.
export function swappedPaneParams(
  left: PaneParams,
  right: PaneParams,
  mainRange: TimeRange,
  mainFrom: string,
  mainUntil: string,
): Record<string, string | null> {
  // Queries always swap as raw overrides (null deletes the param, so an
  // inheriting pane stays inheriting). Swapping the *resolved* query instead
  // would materialize a not-yet-initialized empty query, and would leave a
  // pane pinned to today's main query even after the main query changes.
  const queries = {
    leftQuery: right.queryOverride,
    rightQuery: left.queryOverride,
  };

  // Case 1: at least one side carries an explicit bound. An overridden bound
  // moves as its raw string — resolving it first and writing an absolute
  // number would pin a pane that was tracking a relative bound to a fixed
  // instant, silently freezing it. But a bound left *absent* can't move as
  // null: null means "this side's default half", and the default half
  // differs per side, so a null crossing from one side to the other resolves
  // against the wrong side's default instead of reproducing the window it
  // came from. completedPaneWindow fills in only the absent bounds (from
  // that side's own resolved default) before the window moves.
  if (
    left.fromOverride != null ||
    left.untilOverride != null ||
    right.fromOverride != null ||
    right.untilOverride != null
  ) {
    const isRelativeMain =
      isRelative(mainFrom) && (mainUntil === 'now' || !mainUntil);
    const mainSpan = mainRange.end - mainRange.start;
    const leftWindow = completedPaneWindow(
      'left',
      left,
      isRelativeMain,
      mainSpan,
    );
    const rightWindow = completedPaneWindow(
      'right',
      right,
      isRelativeMain,
      mainSpan,
    );
    return {
      ...queries,
      leftFrom: rightWindow.from,
      leftUntil: rightWindow.until,
      rightFrom: leftWindow.from,
      rightUntil: leftWindow.until,
    };
  }

  const span = mainRange.end - mainRange.start;
  // Case 2: both panes are still at their defaults (no raw overrides at
  // all) and the main range is relative. A raw-null swap here would be a
  // visible no-op — both panes would keep resolving to the exact halves
  // they already show — so instead emit explicit relative params that swap
  // which half is which (left takes the later half, right the earlier one),
  // keeping the comparison sliding under auto-refresh instead of freezing
  // it the way writing absolute bounds would. Needs a whole-second span to
  // express exactly as "now-Ns".
  if (
    isRelative(mainFrom) &&
    (mainUntil === 'now' || !mainUntil) &&
    span % 2000 === 0
  ) {
    const halfSeconds = span / 2 / 1000;
    const fullSeconds = span / 1000;
    return {
      ...queries,
      leftFrom: `now-${halfSeconds}s`,
      leftUntil: 'now',
      rightFrom: `now-${fullSeconds}s`,
      rightUntil: `now-${halfSeconds}s`,
    };
  }

  // Case 3: both panes are at their defaults, but the main range is
  // absolute (or its span doesn't divide evenly into whole seconds). There
  // is nothing live to freeze here — an absolute main range doesn't
  // auto-refresh either — so fall back to exchanging the resolved halves,
  // which is what makes a swap have a visible effect from a bare deep link.
  return {
    ...queries,
    leftFrom: String(right.range.start),
    leftUntil: String(right.range.end),
    rightFrom: String(left.range.start),
    rightUntil: String(left.range.end),
  };
}
