import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { useEditBuffer } from './useEditBuffer.ts';

const buffer = (initial: string) =>
  renderHook(({ value }) => useEditBuffer(value), {
    initialProps: { value: initial },
  });

describe('useEditBuffer', () => {
  it('starts at the URL value', () => {
    const { result } = buffer('{a="b"}');
    assert.equal(result.current[0], '{a="b"}');
  });

  it('holds what was typed without touching the URL value', () => {
    // Typing must not navigate; the URL only moves on Run.
    const { result } = buffer('{a="b"}');
    act(() => result.current[1]('{a="b", region="eu"}'));
    assert.equal(result.current[0], '{a="b", region="eu"}');
  });

  it('keeps the edit across unrelated re-renders', () => {
    const { result, rerender } = buffer('{a="b"}');
    act(() => result.current[1]('typing'));
    rerender({ value: '{a="b"}' });
    assert.equal(result.current[0], 'typing');
  });

  it('drops the edit when the URL value changes underneath', () => {
    // Back, a link, or another control writing the same param: the address
    // bar wins, or the stale draft quietly contradicts it.
    const { result, rerender } = buffer('{a="b"}');
    act(() => result.current[1]('half-typed'));
    rerender({ value: '{c="d"}' });
    assert.equal(result.current[0], '{c="d"}');
  });

  it('drops the edit even when it matched the incoming value', () => {
    const { result, rerender } = buffer('{a="b"}');
    act(() => result.current[1]('{c="d"}'));
    rerender({ value: '{c="d"}' });
    assert.equal(result.current[0], '{c="d"}');
    // And the buffer is genuinely empty again, so a later URL change shows.
    rerender({ value: '{e="f"}' });
    assert.equal(result.current[0], '{e="f"}');
  });

  it('lets the same edit be made again after a reset', () => {
    const { result, rerender } = buffer('{a="b"}');
    act(() => result.current[1]('draft'));
    rerender({ value: '{c="d"}' });
    act(() => result.current[1]('draft'));
    assert.equal(result.current[0], 'draft');
  });

  it('accepts an empty edit rather than falling back to the URL', () => {
    // Clearing the field is a real intention, not an absent draft.
    const { result } = buffer('{a="b"}');
    act(() => result.current[1](''));
    assert.equal(result.current[0], '');
  });

  it('tracks the URL value while nothing has been typed', () => {
    const { result, rerender } = buffer('{a="b"}');
    rerender({ value: '{c="d"}' });
    assert.equal(result.current[0], '{c="d"}');
    rerender({ value: '{e="f"}' });
    assert.equal(result.current[0], '{e="f"}');
  });
});
