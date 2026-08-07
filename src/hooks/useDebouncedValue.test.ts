import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { useDebouncedValue } from './useDebouncedValue.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('useDebouncedValue', () => {
  it('starts at the current value', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300));
    assert.equal(result.current, 'a');
  });

  it('holds the old value until the delay has passed', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    assert.equal(result.current, 'a');
    advance(299);
    assert.equal(result.current, 'a');
    advance(1);
    assert.equal(result.current, 'b');
  });

  it('only settles once the value stops changing', () => {
    // Typing: each keystroke restarts the clock, so nothing is fetched for
    // an intermediate query.
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'r' } },
    );
    for (const value of ['re', 'reg', 'regi']) {
      rerender({ value });
      advance(200);
      assert.equal(result.current, 'r');
    }
    advance(300);
    assert.equal(result.current, 'regi');
  });

  it('drops a pending update when the value returns to the last one', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    advance(100);
    rerender({ value: 'a' });
    advance(300);
    assert.equal(result.current, 'a');
  });

  it('restarts the wait when the delay changes', () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: 'a', delay: 300 } },
    );
    rerender({ value: 'b', delay: 1000 });
    advance(300);
    assert.equal(result.current, 'a');
    advance(700);
    assert.equal(result.current, 'b');
  });

  it('stops the timer on unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    unmount();
    // A surviving timer would setState on an unmounted hook.
    assert.equal(vi.getTimerCount(), 0);
  });
});
