import { renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';
import { useComparisonParams } from './comparisonParams.ts';

const MAIN_QUERY = '{service_name="web", profile_type="a:b:c:d:e"}';
const START = new Date(2026, 7, 7, 12, 0, 0).getTime();
const END = START + 3_600_000;
const MID = START + 1_800_000;
const RANGE = { start: START, end: END };

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

  it('takes absolute bounds from the URL', () => {
    at(`/comparison?leftFrom=${START}&leftUntil=${MID}`);
    assert.deepEqual(panes().left.range, { start: START, end: MID });
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
