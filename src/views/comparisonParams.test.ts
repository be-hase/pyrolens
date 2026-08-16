import { renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';
import {
  previousPeriodParams,
  swappedPaneParams,
  useComparisonParams,
  type PaneParams,
} from './comparisonParams.ts';

const MAIN_QUERY = '{service_name="web", profile_type="a:b:c:d:e"}';
const START = new Date(2026, 7, 7, 12, 0, 0).getTime();
const END = START + 3_600_000;
const MID = START + 1_800_000;
const RANGE = { start: START, end: END };
const SPAN = END - START;

const at = (search: string) => window.history.replaceState(null, '', search);

const panes = () =>
  renderHook(() => useComparisonParams(MAIN_QUERY, RANGE)).result.current;

beforeEach(() => at('/comparison'));

describe('useComparisonParams', () => {
  it('splits the main range in half by default', () => {
    const { left, right } = panes();
    assert.deepEqual(left.range, { start: START, end: MID });
    assert.deepEqual(right.range, { start: MID, end: END });
  });

  it('labels each pane with its URL prefix', () => {
    const { left, right } = panes();
    assert.equal(left.side, 'left');
    assert.equal(right.side, 'right');
  });

  it('inherits the main query until a pane overrides it', () => {
    assert.equal(panes().left.query, MAIN_QUERY);
    at('/comparison?leftQuery=%7Bpod%3D%22a%22%7D');
    const { left, right } = panes();
    assert.equal(left.query, '{pod="a"}');
    assert.equal(right.query, MAIN_QUERY);
  });

  it('exposes the raw query override alongside the resolved query', () => {
    assert.equal(panes().left.queryOverride, null);
    at('/comparison?leftQuery=%7Bpod%3D%22a%22%7D');
    assert.equal(panes().left.queryOverride, '{pod="a"}');
  });

  it('takes absolute bounds from the URL', () => {
    at(`/comparison?leftFrom=${START}&leftUntil=${MID}`);
    assert.deepEqual(panes().left.range, { start: START, end: MID });
  });

  it('exposes the raw bound overrides alongside the resolved range', () => {
    assert.equal(panes().left.fromOverride, null);
    assert.equal(panes().left.untilOverride, null);
    at(`/comparison?leftFrom=${START}&leftUntil=${MID}`);
    const { left } = panes();
    assert.equal(left.fromOverride, String(START));
    assert.equal(left.untilOverride, String(MID));
  });

  it('resolves a relative bound against the end of the main range', () => {
    // The main range's end is the pane's "now", so a shared link resolves
    // the same way for whoever opens it.
    at('/comparison?rightFrom=now-15m&rightUntil=now');
    assert.deepEqual(panes().right.range, { start: END - 900_000, end: END });
  });

  it('falls back to the default half when only one bound is set', () => {
    at(`/comparison?leftUntil=${START + 600_000}`);
    assert.deepEqual(panes().left.range, {
      start: START,
      end: START + 600_000,
    });
  });

  it('falls back to the default half for an inverted range', () => {
    at(`/comparison?leftFrom=${END}&leftUntil=${START}`);
    assert.deepEqual(panes().left.range, { start: START, end: MID });
  });

  it('falls back to the default half for an unparseable bound', () => {
    at('/comparison?rightFrom=garbage&rightUntil=nonsense');
    assert.deepEqual(panes().right.range, { start: MID, end: END });
  });

  it('keeps the panes independent', () => {
    at(`/comparison?leftFrom=${START}&leftUntil=${START + 60_000}`);
    const { left, right } = panes();
    assert.deepEqual(left.range, { start: START, end: START + 60_000 });
    assert.deepEqual(right.range, { start: MID, end: END });
  });
});

describe('previousPeriodParams', () => {
  describe('absolute source range', () => {
    const from = String(START);
    const until = String(END);

    it('builds an equal-duration baseline immediately before the range', () => {
      const params = previousPeriodParams(MAIN_QUERY, from, until, RANGE);
      assert.deepEqual(params, {
        from: String(START - SPAN),
        until: String(END),
        leftQuery: MAIN_QUERY,
        rightQuery: MAIN_QUERY,
        leftFrom: String(START - SPAN),
        leftUntil: String(START),
        rightFrom: String(START),
        rightUntil: String(END),
      });
    });

    it('preserves the span for both windows', () => {
      const params = previousPeriodParams(MAIN_QUERY, from, until, RANGE);
      const leftSpan = Number(params.leftUntil) - Number(params.leftFrom);
      const rightSpan = Number(params.rightUntil) - Number(params.rightFrom);
      assert.equal(leftSpan, SPAN);
      assert.equal(rightSpan, SPAN);
    });

    it('abuts the two windows at the start of the visible range', () => {
      const params = previousPeriodParams(MAIN_QUERY, from, until, RANGE);
      assert.equal(params.leftUntil, String(START));
      assert.equal(params.rightFrom, String(START));
    });
  });

  describe('relative source range', () => {
    it('doubles the offset and keeps the widened main range relative', () => {
      // A relative source must not freeze to the resolved RANGE — the whole
      // point is that the widened window keeps auto-refreshing.
      const params = previousPeriodParams(MAIN_QUERY, 'now-1h', 'now', RANGE);
      assert.deepEqual(params, {
        from: 'now-2h',
        until: null,
        leftQuery: MAIN_QUERY,
        rightQuery: MAIN_QUERY,
        leftFrom: 'now-2h',
        leftUntil: 'now-1h',
        rightFrom: 'now-1h',
        rightUntil: 'now',
      });
    });

    it('doubles the numeric offset exactly, in the same unit', () => {
      const params = previousPeriodParams(MAIN_QUERY, 'now-90m', 'now', RANGE);
      assert.equal(params.from, 'now-180m');
      assert.equal(params.leftFrom, 'now-180m');
      assert.equal(params.leftUntil, 'now-90m');
    });

    it('treats an absent until the same as "now"', () => {
      const params = previousPeriodParams(MAIN_QUERY, 'now-30m', '', RANGE);
      assert.equal(params.until, null);
      assert.equal(params.rightUntil, 'now');
    });
  });
});

describe('swappedPaneParams', () => {
  describe('explicit bounds on at least one side', () => {
    const left: PaneParams = {
      side: 'left',
      query: '{service_name="a"}',
      queryOverride: '{service_name="a"}',
      range: { start: START, end: MID },
      fromOverride: String(START),
      untilOverride: String(MID),
    };
    const right: PaneParams = {
      side: 'right',
      query: '{service_name="b"}',
      queryOverride: '{service_name="b"}',
      range: { start: MID, end: END },
      fromOverride: String(MID),
      untilOverride: String(END),
    };

    it('exchanges the raw query and bound overrides verbatim', () => {
      assert.deepEqual(
        swappedPaneParams(left, right, RANGE, String(START), String(END)),
        {
          leftQuery: '{service_name="b"}',
          rightQuery: '{service_name="a"}',
          leftFrom: String(MID),
          leftUntil: String(END),
          rightFrom: String(START),
          rightUntil: String(MID),
        },
      );
    });

    it('swapping twice returns exactly to the original params', () => {
      const once = swappedPaneParams(
        left,
        right,
        RANGE,
        String(START),
        String(END),
      );
      const leftAfter: PaneParams = {
        ...left,
        queryOverride: once.leftQuery,
        fromOverride: once.leftFrom,
        untilOverride: once.leftUntil,
      };
      const rightAfter: PaneParams = {
        ...right,
        queryOverride: once.rightQuery,
        fromOverride: once.rightFrom,
        untilOverride: once.rightUntil,
      };
      const twice = swappedPaneParams(
        leftAfter,
        rightAfter,
        RANGE,
        String(START),
        String(END),
      );
      assert.deepEqual(twice, {
        leftQuery: left.queryOverride,
        rightQuery: right.queryOverride,
        leftFrom: left.fromOverride,
        leftUntil: left.untilOverride,
        rightFrom: right.fromOverride,
        rightUntil: right.untilOverride,
      });
    });
  });

  describe('both panes at their defaults', () => {
    it('falls back to exchanging the resolved halves under an absolute main range', () => {
      at('/comparison');
      const { left, right } = panes();
      assert.deepEqual(
        swappedPaneParams(left, right, RANGE, String(START), String(END)),
        {
          leftQuery: null,
          rightQuery: null,
          leftFrom: String(MID),
          leftUntil: String(END),
          rightFrom: String(START),
          rightUntil: String(MID),
        },
      );
    });

    it('falls back to exchanging the resolved halves when the span does not divide into whole seconds', () => {
      at('/comparison');
      // A relative main range, but with a sub-second remainder that
      // "now-Ns" cannot express exactly.
      const oddRange = { start: START, end: END + 1 };
      const { left, right } = renderHook(() =>
        useComparisonParams(MAIN_QUERY, oddRange),
      ).result.current;
      assert.deepEqual(
        swappedPaneParams(left, right, oddRange, 'now-1h', 'now'),
        {
          leftQuery: null,
          rightQuery: null,
          leftFrom: String(right.range.start),
          leftUntil: String(right.range.end),
          rightFrom: String(left.range.start),
          rightUntil: String(left.range.end),
        },
      );
    });

    it('slides to relative halves under a relative main range with a whole-second span', () => {
      at('/comparison');
      const { left, right } = panes();
      assert.deepEqual(swappedPaneParams(left, right, RANGE, 'now-1h', 'now'), {
        leftQuery: null,
        rightQuery: null,
        leftFrom: 'now-1800s',
        leftUntil: 'now',
        rightFrom: 'now-3600s',
        rightUntil: 'now-1800s',
      });
    });

    it('treats an absent until the same as "now" for the relative case', () => {
      at('/comparison');
      const { left, right } = panes();
      const params = swappedPaneParams(left, right, RANGE, 'now-1h', '');
      assert.equal(params.leftFrom, 'now-1800s');
      assert.equal(params.rightUntil, 'now-1800s');
    });

    it('swapping twice from relative defaults returns to the default-equivalent relative params', () => {
      at('/comparison');
      const { left, right } = panes();
      const once = swappedPaneParams(left, right, RANGE, 'now-1h', 'now');

      // Apply the swap the way `navigate` would (nulls just never get set).
      const qs = new URLSearchParams();
      qs.set('leftFrom', once.leftFrom as string);
      qs.set('leftUntil', once.leftUntil as string);
      qs.set('rightFrom', once.rightFrom as string);
      qs.set('rightUntil', once.rightUntil as string);
      at(`/comparison?${qs}`);
      const { left: afterLeft, right: afterRight } = panes();

      const twice = swappedPaneParams(
        afterLeft,
        afterRight,
        RANGE,
        'now-1h',
        'now',
      );
      // Back to the halves the very first (override-free) render showed —
      // "equivalent" because they now arrive as explicit relative params
      // rather than absent ones, not because the object is byte-identical
      // to the very first swap's input.
      assert.deepEqual(twice, {
        leftQuery: null,
        rightQuery: null,
        leftFrom: 'now-3600s',
        leftUntil: 'now-1800s',
        rightFrom: 'now-1800s',
        rightUntil: 'now',
      });
    });
  });
});
