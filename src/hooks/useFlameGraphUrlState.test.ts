import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { navigate } from '../urlState';
import { useFlameGraphUrlState } from './useFlameGraphUrlState.ts';

// Renders the actual stateful hook (not just the pure functions
// FlameGraph.test.tsx exercises) — renderHook needs no canvas, so the jsdom
// limitation that keeps the vendored flame graph itself out of these tests
// (AGENTS.md's "Verifying a change") does not apply here.

const SEARCH_DEBOUNCE_MS = 400;
const at = (search: string) => window.history.replaceState(null, '', search);
const params = () => new URLSearchParams(window.location.search);

beforeEach(() => {
  at('/');
  vi.useFakeTimers();
});
afterEach(() => {
  at('/');
  vi.useRealTimers();
});

describe('useFlameGraphUrlState', () => {
  it('writes the debounced search once it settles, with no push in the way', () => {
    const { result } = renderHook(() => useFlameGraphUrlState());
    act(() => result.current.onSearchChange('alloc'));
    assert.equal(result.current.search, 'alloc');

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    assert.equal(params().get('fgSearch'), 'alloc');
  });

  it('(d) drops a debounced write typed while fgSearch was absent, when a push lands mid-debounce and fgSearch is still absent afterwards, resetting the box to the committed (empty) value', () => {
    // useEditBuffer's own reset is keyed on the *committed* fgSearch value
    // itself changing — fgSearch was absent before the push and stays
    // absent after (the push, e.g. Reset view, clears every OTHER param),
    // so that reset never fires on its own; only the push-generation guard
    // catches this.
    const { result } = renderHook(() => useFlameGraphUrlState());
    act(() => result.current.onSearchChange('alloc'));
    assert.equal(result.current.search, 'alloc');

    act(() => navigate({ path: '/comparison' }));

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    assert.equal(params().has('fgSearch'), false);
    assert.equal(
      result.current.search,
      '',
      'the box must fall back to the committed (empty) value instead of keeping stale text it can never apply',
    );
  });

  it('a background replace navigation mid-debounce (e.g. the sandwich toggle) does not cancel a pending search write', () => {
    // Regression guard mirroring MaxNodesControl's: a replace must not be
    // mistaken for a push (urlState.ts's pushGenerationNow only moves on a
    // push or a popstate).
    const { result } = renderHook(() => useFlameGraphUrlState());
    act(() => result.current.onSearchChange('alloc'));

    act(() => navigate({ replace: true, set: { fgSandwich: 'main.fn' } }));

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    assert.equal(params().get('fgSearch'), 'alloc');
  });
});
