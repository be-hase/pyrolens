import { isRelative, resolveTime, type TimeRange } from '../time';
import { useRoute } from '../urlState';

// Mirrors src/time.ts's (unexported) unit table — this file's arithmetic on
// relative offsets is the only other place that needs it.
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
const RELATIVE_OFFSET = /^now-(\d+)([smhdw])$/;

// Largest unit (w down to s) that expresses `ms` with no remainder. Offsets
// built from "now-N<unit>" values are always whole seconds at minimum, so
// this never needs a fallback past "s".
function expressOffset(ms: number): string {
  const units: [string, number][] = [
    ['w', UNIT_MS.w],
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
    ['s', UNIT_MS.s],
  ];
  for (const [suffix, size] of units) {
    if (ms % size === 0) return `now-${ms / size}${suffix}`;
  }
  return `now-${Math.round(ms / 1000)}s`;
}

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
    const rel = from.match(RELATIVE_OFFSET);
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
  } else if (isRelative(from) && isRelative(until)) {
    // `until` is itself a moving offset ("now-5m"), not just "now" — the
    // same failure mode as above, just with a nonzero right edge. Unlike the
    // until==='now' case, the two ends can be different units, so this does
    // the widening in milliseconds and re-expresses the result in whatever
    // unit divides it exactly, rather than trying to stay in `from`'s unit.
    const fromRel = from.match(RELATIVE_OFFSET);
    const untilRel = until.match(RELATIVE_OFFSET);
    if (fromRel && untilRel) {
      const fromOffset = Number(fromRel[1]) * UNIT_MS[fromRel[2]];
      const untilOffset = Number(untilRel[1]) * UNIT_MS[untilRel[2]];
      // fromOffset must be the larger (further-back) offset, or the pair is
      // degenerate/inverted; fall through to the absolute branch below,
      // which only reads the already-resolved `range` and so handles an
      // inverted pair the same way it handles one passed as absolute ms.
      if (fromOffset > untilOffset) {
        const span = fromOffset - untilOffset;
        const widenedFrom = expressOffset(2 * fromOffset - untilOffset);
        // Pane params (leftFrom/leftUntil/rightFrom/rightUntil) live in a
        // different coordinate frame than the main from/until: useComparisonParams
        // resolves them with `now = mainRange.end`, not the wall clock. Here
        // mainRange.end is realNow - untilOffset, not realNow itself (unlike
        // the until==='now' branch above, where the two coincide and reusing
        // main-frame strings is exact) — so reusing `from`/`until` verbatim
        // as pane bounds would apply the until-offset a second time. The
        // pane frame only needs the span: the anchor already sits at the
        // widened window's un-widened `until`, so "now" IS that boundary.
        return {
          from: widenedFrom,
          until,
          leftQuery: query,
          rightQuery: query,
          leftFrom: expressOffset(2 * span),
          leftUntil: expressOffset(span),
          rightFrom: expressOffset(span),
          rightUntil: 'now',
        };
      }
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
  // useComparisonParams) — always expressible when the main range is
  // relative, and correct whether the main range's own raw `until` is "now"
  // or an offset like "now-5m": a pane's "now" always resolves against
  // mainRange.end, never against the main range's raw until string.
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
    // A moving main range isn't only the literal until==='now' spelling —
    // "now-5m" advances too (see previousPeriodParams above) — so this has
    // to accept any relative until, not just "now"/absent, or a range like
    // that falls to the absolute branch below and Swap sides freezes it.
    const isRelativeMain =
      isRelative(mainFrom) && (isRelative(mainUntil) || !mainUntil);
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
  // all) and the main range is relative — either until==='now' or a moving
  // offset like "now-5m" (see the isRelativeMain comment in Case 1; a pane's
  // "now" anchors to mainRange.end regardless of which spelling the main
  // range uses). A raw-null swap here would be a visible no-op — both panes
  // would keep resolving to the exact halves they already show — so instead
  // emit explicit relative params that swap which half is which (left takes
  // the later half, right the earlier one), keeping the comparison sliding
  // under auto-refresh instead of freezing it the way writing absolute
  // bounds would. Needs a whole-second span to express exactly as "now-Ns".
  if (
    isRelative(mainFrom) &&
    (isRelative(mainUntil) || !mainUntil) &&
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
