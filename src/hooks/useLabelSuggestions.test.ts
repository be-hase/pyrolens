import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchLabelNames, fetchLabelValues } from '@api/client';
import {
  applySuggestion,
  getSuggestionContext,
  useLabelSuggestions,
} from './useLabelSuggestions.ts';

vi.mock('@api/client', () => ({
  fetchLabelNames: vi.fn(),
  fetchLabelValues: vi.fn(),
}));

const namesOf = vi.mocked(fetchLabelNames);
const valuesOf = vi.mocked(fetchLabelValues);

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

describe('getSuggestionContext', () => {
  it('completes a label name right after the brace', () => {
    assert.deepEqual(getSuggestionContext('{', 1), {
      kind: 'name',
      labelName: '',
      prefix: '',
      replaceStart: 1,
      replaceEnd: 1,
    });
  });

  it('completes a partially typed label name', () => {
    assert.deepEqual(getSuggestionContext('{ser', 4), {
      kind: 'name',
      labelName: '',
      prefix: 'ser',
      replaceStart: 1,
      replaceEnd: 4,
    });
  });

  it('completes a label name after a comma', () => {
    const ctx = getSuggestionContext('{a="b", re', 10);
    assert.equal(ctx?.kind, 'name');
    assert.equal(ctx?.prefix, 're');
    assert.equal(ctx?.replaceStart, 8);
  });

  it('covers the rest of the name the caret sits inside', () => {
    // Caret between "se" and "rvice": accepting a suggestion must replace the
    // whole word, not leave "rvice" behind.
    const ctx = getSuggestionContext('{service_name="a"}', 3);
    assert.equal(ctx?.kind, 'name');
    assert.equal(ctx?.prefix, 'se');
    assert.deepEqual([ctx?.replaceStart, ctx?.replaceEnd], [1, 13]);
  });

  it('completes a label value inside the quotes', () => {
    const ctx = getSuggestionContext('{service_name="w', 16);
    assert.equal(ctx?.kind, 'value');
    assert.equal(ctx?.labelName, 'service_name');
    assert.equal(ctx?.prefix, 'w');
    assert.equal(ctx?.replaceStart, 15);
  });

  it('covers the rest of the value the caret sits inside', () => {
    const ctx = getSuggestionContext('{region="useast"}', 11);
    assert.equal(ctx?.prefix, 'us');
    assert.deepEqual([ctx?.replaceStart, ctx?.replaceEnd], [9, 15]);
  });

  it('recognizes every matcher operator', () => {
    for (const op of ['=', '!=', '=~', '!~']) {
      const text = `{region${op}"eu`;
      const ctx = getSuggestionContext(text, text.length);
      assert.equal(ctx?.kind, 'value', op);
      assert.equal(ctx?.labelName, 'region', op);
      assert.equal(ctx?.prefix, 'eu', op);
    }
  });

  it('tolerates whitespace around the operator', () => {
    const text = '{region = "e';
    const ctx = getSuggestionContext(text, text.length);
    assert.equal(ctx?.kind, 'value');
    assert.equal(ctx?.labelName, 'region');
  });

  it('offers nothing outside a selector', () => {
    assert.equal(getSuggestionContext('', 0), null);
    assert.equal(getSuggestionContext('service', 7), null);
    // The selector is already closed before the caret.
    assert.equal(getSuggestionContext('{a="b"} tail', 12), null);
  });

  it('reads the context at the caret, not at the end of the text', () => {
    assert.equal(getSuggestionContext('{a="b"}', 7), null);
    assert.equal(getSuggestionContext('{a="b"}', 4)?.kind, 'value');
  });
});

describe('applySuggestion', () => {
  const contextAt = (text: string, caret: number) => {
    const ctx = getSuggestionContext(text, caret);
    assert.ok(ctx, `no context for ${text}@${caret}`);
    return ctx;
  };

  it('starts a matcher and puts the caret between the quotes', () => {
    const text = '{}';
    const next = applySuggestion(text, contextAt(text, 1), 'region');
    assert.equal(next.value, '{region=""}');
    assert.equal(next.caret, 9);
    assert.equal(next.value[next.caret - 1], '"');
    assert.equal(next.value[next.caret], '"');
  });

  it('keeps an existing operator when re-completing a name', () => {
    const text = '{reg="x"}';
    const next = applySuggestion(text, contextAt(text, 4), 'region');
    assert.equal(next.value, '{region="x"}');
    assert.equal(next.caret, 7);
  });

  it('fills in a value and closes the quote', () => {
    const text = '{region="';
    const next = applySuggestion(text, contextAt(text, 9), 'eu-west');
    assert.equal(next.value, '{region="eu-west"');
    assert.equal(next.caret, next.value.length);
  });

  it('reuses a closing quote that is already there', () => {
    const text = '{region=""}';
    const next = applySuggestion(text, contextAt(text, 9), 'eu-west');
    assert.equal(next.value, '{region="eu-west"}');
  });

  it('replaces the value the caret is inside', () => {
    const text = '{region="useast"}';
    const next = applySuggestion(text, contextAt(text, 11), 'eu-west');
    assert.equal(next.value, '{region="eu-west"}');
  });

  it('escapes a value so the selector keeps its meaning', () => {
    // A suggestion containing a backslash silently queried something else
    // before this was escaped.
    const text = '{path=""}';
    const next = applySuggestion(text, contextAt(text, 7), 'C:\\tmp "x"');
    assert.equal(next.value, '{path="C:\\\\tmp \\"x\\""}');
    assert.equal(next.value[next.caret - 1], '"');
  });
});

describe('useLabelSuggestions', () => {
  const RANGE = { start: 1_000, end: 2_000 };

  const setup = (props: {
    text: string;
    caret: number;
    enabled?: boolean;
    tenantID?: string;
  }) =>
    renderHook(
      (p: typeof props) =>
        useLabelSuggestions({
          ...p,
          start: RANGE.start,
          end: RANGE.end,
          enabled: p.enabled ?? true,
        }),
      { initialProps: props },
    );

  beforeEach(() => {
    vi.useFakeTimers();
    namesOf.mockResolvedValue(['region', 'pod', '__session_id__']);
    valuesOf.mockResolvedValue(['eu-west', 'us-east']);
  });
  afterEach(() => vi.useRealTimers());

  /** Lets the pending fetches settle without leaving fake timers. */
  const flush = () => act(async () => {});

  it('offers nothing while the popup is closed', async () => {
    const { result } = setup({ text: '{', caret: 1, enabled: false });
    await flush();
    assert.equal(result.current.context, null);
    assert.deepEqual(result.current.suggestions, []);
    assert.equal(namesOf.mock.calls.length, 0);
  });

  it('suggests label names, hiding the internal ones', async () => {
    const { result } = setup({ text: '{', caret: 1 });
    await flush();
    assert.deepEqual(result.current.suggestions, ['region', 'pod']);
    assert.deepEqual(namesOf.mock.calls[0].slice(0, 3), [
      [],
      RANGE.start,
      RANGE.end,
    ]);
  });

  it('filters the names against what was typed', async () => {
    const { result } = setup({ text: '{re', caret: 3 });
    await flush();
    assert.deepEqual(result.current.suggestions, ['region']);
  });

  it('suggests values for the label being edited', async () => {
    const { result } = setup({ text: '{region="', caret: 9 });
    await flush();
    assert.equal(valuesOf.mock.calls[0][0], 'region');
    assert.deepEqual(result.current.suggestions, ['eu-west', 'us-east']);
  });

  it('waits for the label to settle before asking for other values', async () => {
    const { rerender } = setup({ text: '{region="', caret: 9 });
    await flush();
    assert.equal(valuesOf.mock.calls.length, 1);

    rerender({ text: '{pod="', caret: 6 });
    await flush();
    assert.equal(valuesOf.mock.calls.length, 1);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await flush();
    assert.equal(valuesOf.mock.calls.length, 2);
    assert.equal(valuesOf.mock.calls[1][0], 'pod');
  });

  it("never offers one label's values under another", async () => {
    const { result, rerender } = setup({ text: '{region="', caret: 9 });
    await flush();
    assert.deepEqual(result.current.suggestions, ['eu-west', 'us-east']);

    // Mid-switch the fetched pool still belongs to `region`; offering it for
    // `pod` would build a selector that matches nothing.
    rerender({ text: '{pod="', caret: 6 });
    await flush();
    assert.deepEqual(result.current.suggestions, []);
  });

  it('re-requests names when the range moves', async () => {
    const { result, rerender } = renderHook(
      (p: { end: number }) =>
        useLabelSuggestions({
          text: '{',
          caret: 1,
          start: RANGE.start,
          end: p.end,
          enabled: true,
        }),
      { initialProps: { end: RANGE.end } },
    );
    await flush();
    assert.equal(namesOf.mock.calls.length, 1);

    rerender({ end: RANGE.end + 60_000 });
    await flush();
    assert.equal(namesOf.mock.calls.length, 1, 'debounced, not yet refetched');

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    assert.equal(namesOf.mock.calls.length, 2);
    assert.equal(namesOf.mock.calls[1][2], RANGE.end + 60_000);
    assert.deepEqual(result.current.suggestions, ['region', 'pod']);
  });

  it('does not stick on a stale range after a superseded fetch beats abort()', async () => {
    // Bug: the names effect's cleanup (`controller.abort()`) only runs when
    // React flushes this effect's passive-effect pass, but a fetch's
    // continuation is a microtask that can beat a *scheduled* flush — so a
    // response can finish parsing, with `signal.aborted` still false, after
    // the range has already moved on. `act()` makes React run that cleanup
    // synchronously with the render that triggers it, so this harness can't
    // reproduce the race by timing alone; neutering `abort()` for the
    // window stands in for "abort() does nothing to an already-parsed
    // response" without depending on real event-loop ordering.
    const first = deferred<string[]>();
    namesOf.mockReturnValueOnce(first.promise);
    namesOf.mockResolvedValueOnce(['region2']);

    const { result, rerender } = renderHook(
      (p: { end: number }) =>
        useLabelSuggestions({
          text: '{',
          caret: 1,
          start: RANGE.start,
          end: p.end,
          enabled: true,
        }),
      { initialProps: { end: RANGE.end } },
    );
    await flush();
    assert.equal(namesOf.mock.calls.length, 1);

    const abortSpy = vi
      .spyOn(AbortController.prototype, 'abort')
      .mockImplementation(() => {});
    try {
      rerender({ end: RANGE.end + 60_000 });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      abortSpy.mockRestore();
    }

    assert.equal(namesOf.mock.calls.length, 2, 'range 2 was fetched');
    assert.deepEqual(result.current.suggestions, ['region2']);

    // The range-1 fetch finally resolves, with `signal.aborted` still false.
    await act(async () => {
      first.settle(['region1']);
      await first.promise;
    });

    assert.deepEqual(
      result.current.suggestions,
      ['region2'],
      'must not be clobbered by the superseded range-1 response',
    );
  });

  it('does not stick with stale values when the replacement fetch fails', async () => {
    // Same race as the names test above, but for the values effect: the
    // render that changes the pool key resets `values` and commits
    // synchronously, while this effect's cleanup (`controller.abort()`)
    // only runs at the later passive-effect flush. A tenant-1 response
    // that finishes parsing in that gap sees `aborted === false`. Unlike
    // names, the values effect always re-fetches on the next tenant/range/
    // label — the question is whether that replacement fetch rejecting
    // leaves the stale write stuck forever.
    const first = deferred<string[]>();
    valuesOf.mockReturnValueOnce(first.promise);
    valuesOf.mockRejectedValueOnce(new Error('down'));

    const { result, rerender } = renderHook(
      (p: { tenantID: string }) =>
        useLabelSuggestions({
          text: '{region="',
          caret: 9,
          start: RANGE.start,
          end: RANGE.end,
          tenantID: p.tenantID,
          enabled: true,
        }),
      { initialProps: { tenantID: 't1' } },
    );
    await flush();
    assert.equal(valuesOf.mock.calls.length, 1);

    const abortSpy = vi
      .spyOn(AbortController.prototype, 'abort')
      .mockImplementation(() => {});
    try {
      rerender({ tenantID: 't2' });
      await act(async () => {});
    } finally {
      abortSpy.mockRestore();
    }

    assert.equal(valuesOf.mock.calls.length, 2, 'tenant 2 was fetched');
    assert.deepEqual(
      result.current.suggestions,
      [],
      'tenant-2 fetch rejected; nothing should have landed yet',
    );

    // The tenant-1 fetch finally resolves, with `signal.aborted` still
    // false because abort() was neutered above.
    await act(async () => {
      first.settle(['eu-west', 'us-east']);
      await first.promise;
    });

    assert.deepEqual(
      result.current.suggestions,
      [],
      'must not be clobbered by the superseded tenant-1 response',
    );
  });

  it('survives a failed lookup with an empty list', async () => {
    namesOf.mockRejectedValueOnce(new Error('down'));
    const { result } = setup({ text: '{', caret: 1 });
    await flush();
    assert.deepEqual(result.current.suggestions, []);
  });

  it('applies a suggestion through the caret context', async () => {
    const { result } = setup({ text: '{}', caret: 1 });
    await flush();
    assert.deepEqual(result.current.apply('region'), {
      value: '{region=""}',
      caret: 9,
    });
  });

  it('leaves the text alone when there is no context to apply to', async () => {
    const { result } = setup({ text: 'nonsense', caret: 8 });
    await flush();
    assert.deepEqual(result.current.apply('region'), {
      value: 'nonsense',
      caret: 8,
    });
  });
});
