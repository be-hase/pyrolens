import { act, renderHook, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { fetchFlamegraph, fetchTimeline } from '@api/client';
import { useFlamegraph, useTimeline } from './useProfileData.ts';

vi.mock('@api/client', () => ({
  fetchFlamegraph: vi.fn(),
  fetchTimeline: vi.fn(),
}));

const flamegraphOf = vi.mocked(fetchFlamegraph);
const timelineOf = vi.mocked(fetchTimeline);

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const QUERY = `{service_name="web", profile_type="${CPU}"}`;
const OTHER = `{service_name="api", profile_type="${CPU}"}`;
const RANGE = { start: 1_000_000, end: 4_600_000 };

const profile = (name: string) => ({ names: [name], levels: [[0, 1, 0, 0]] });

/** A promise this test decides when to settle. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

beforeEach(() => {
  flamegraphOf.mockResolvedValue(profile('total'));
  timelineOf.mockResolvedValue([{ timestamp: 1_000_000, value: 1 }]);
});

describe('useFlamegraph', () => {
  it('fetches the split query for the range', async () => {
    renderHook(() => useFlamegraph({ query: QUERY, range: RANGE }));
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    const [params, signal] = flamegraphOf.mock.calls[0];
    assert.deepEqual(params, {
      profileTypeID: CPU,
      labelSelector: '{service_name="web"}',
      start: RANGE.start,
      end: RANGE.end,
    });
    assert.ok(signal instanceof AbortSignal);
  });

  it('shows a spinner while in flight and the profile once it lands', async () => {
    const first = deferred<ReturnType<typeof profile>>();
    flamegraphOf.mockReturnValue(first.promise);
    const { result } = renderHook(() =>
      useFlamegraph({ query: QUERY, range: RANGE }),
    );
    await waitFor(() => assert.equal(result.current.loading, true));
    await act(async () => {
      first.settle(profile('main'));
      await first.promise;
    });
    assert.equal(result.current.loading, false);
    assert.deepEqual(result.current.flamegraph.names, ['main']);
    assert.equal(result.current.error, null);
  });

  it('surfaces a failure as an error message', async () => {
    flamegraphOf.mockRejectedValueOnce(new Error('upstream is down'));
    const { result } = renderHook(() =>
      useFlamegraph({ query: QUERY, range: RANGE }),
    );
    await waitFor(() => assert.equal(result.current.error, 'upstream is down'));
    assert.equal(result.current.loading, false);
  });

  it('explains a malformed query instead of fetching', async () => {
    const { result } = renderHook(() =>
      useFlamegraph({ query: '{unclosed="a"', range: RANGE }),
    );
    assert.match(result.current.error ?? '', /Could not parse the query/);
    assert.equal(result.current.loading, false);
    assert.equal(flamegraphOf.mock.calls.length, 0);
  });

  it('stays idle when there is nothing to fetch', () => {
    for (const query of ['', '{service_name="web"}']) {
      const { result } = renderHook(() =>
        useFlamegraph({ query, range: RANGE }),
      );
      assert.equal(result.current.loading, false, query);
      assert.equal(result.current.error, null, query);
    }
    assert.equal(flamegraphOf.mock.calls.length, 0);
  });

  it('does not fetch while disabled', () => {
    renderHook(() =>
      useFlamegraph({ query: QUERY, range: RANGE, enabled: false }),
    );
    assert.equal(flamegraphOf.mock.calls.length, 0);
  });

  it('drops the error as soon as there is nothing to fetch', async () => {
    // Derived, not stored: an effect that reset these left the spinner
    // running forever whenever the next query was unparseable.
    flamegraphOf.mockRejectedValueOnce(new Error('boom'));
    const { result, rerender } = renderHook(
      ({ query }) => useFlamegraph({ query, range: RANGE }),
      { initialProps: { query: QUERY } },
    );
    await waitFor(() => assert.equal(result.current.error, 'boom'));
    rerender({ query: '' });
    assert.equal(result.current.error, null);
    assert.equal(result.current.loading, false);
  });

  it('ignores a superseded response that lands late', async () => {
    // Rapid navigation: the first request resolves after the second one has
    // already painted, and must not overwrite it.
    const first = deferred<ReturnType<typeof profile>>();
    const second = deferred<ReturnType<typeof profile>>();
    flamegraphOf.mockReturnValueOnce(first.promise);
    flamegraphOf.mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ query }) => useFlamegraph({ query, range: RANGE }),
      { initialProps: { query: QUERY } },
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    rerender({ query: OTHER });
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 2));

    await act(async () => {
      second.settle(profile('second'));
      await second.promise;
    });
    assert.deepEqual(result.current.flamegraph.names, ['second']);

    await act(async () => {
      first.settle(profile('first'));
      await first.promise;
    });
    assert.deepEqual(result.current.flamegraph.names, ['second']);
    assert.equal(result.current.loading, false);
  });

  it('ignores a superseded failure too', async () => {
    const first = deferred<ReturnType<typeof profile>>();
    flamegraphOf.mockReturnValueOnce(first.promise);
    flamegraphOf.mockResolvedValueOnce(profile('second'));

    const { result, rerender } = renderHook(
      ({ query }) => useFlamegraph({ query, range: RANGE }),
      { initialProps: { query: QUERY } },
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    rerender({ query: OTHER });
    await waitFor(() =>
      assert.deepEqual(result.current.flamegraph.names, ['second']),
    );

    await act(async () => {
      first.fail(new Error('aborted request'));
      await first.promise.catch(() => {});
    });
    assert.equal(result.current.error, null);
  });

  it('aborts the request it leaves behind', async () => {
    const { rerender } = renderHook(
      ({ query }) => useFlamegraph({ query, range: RANGE }),
      { initialProps: { query: QUERY } },
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    const signal = flamegraphOf.mock.calls[0][1];
    rerender({ query: OTHER });
    assert.equal(signal?.aborted, true);
  });

  it('aborts on unmount', async () => {
    const { unmount } = renderHook(() =>
      useFlamegraph({ query: QUERY, range: RANGE }),
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    const signal = flamegraphOf.mock.calls[0][1];
    unmount();
    assert.equal(signal?.aborted, true);
  });

  it('refetches when the tenant changes', async () => {
    const { rerender } = renderHook(
      ({ tenantID }) => useFlamegraph({ query: QUERY, range: RANGE, tenantID }),
      { initialProps: { tenantID: 'team-a' } },
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    rerender({ tenantID: 'team-b' });
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 2));
  });

  it('does not refetch when nothing it queries on changed', async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useFlamegraph({ query: QUERY, range: RANGE, enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => assert.equal(flamegraphOf.mock.calls.length, 1));
    rerender({ enabled: true });
    rerender({ enabled: true });
    assert.equal(flamegraphOf.mock.calls.length, 1);
  });
});

describe('useTimeline', () => {
  it('asks for a step sized to the range', async () => {
    renderHook(() => useTimeline({ query: QUERY, range: RANGE }));
    await waitFor(() => assert.equal(timelineOf.mock.calls.length, 1));
    // ~100 points across the range, floored at 15s.
    assert.equal(timelineOf.mock.calls[0][0].step, 36);
  });

  it('returns the points once they land', async () => {
    const { result } = renderHook(() =>
      useTimeline({ query: QUERY, range: RANGE }),
    );
    await waitFor(() => assert.equal(result.current.timeline.length, 1));
    assert.deepEqual(result.current.timeline[0], {
      timestamp: 1_000_000,
      value: 1,
    });
  });

  it('surfaces a failure and explains a malformed query', async () => {
    timelineOf.mockRejectedValueOnce(new Error('nope'));
    const { result } = renderHook(() =>
      useTimeline({ query: QUERY, range: RANGE }),
    );
    await waitFor(() => assert.equal(result.current.error, 'nope'));

    const malformed = renderHook(() =>
      useTimeline({ query: 'garbage {{{', range: RANGE }),
    );
    assert.match(malformed.result.current.error ?? '', /Could not parse/);
  });

  it('ignores a superseded response that lands late', async () => {
    const first = deferred<{ timestamp: number; value: number }[]>();
    timelineOf.mockReturnValueOnce(first.promise);
    timelineOf.mockResolvedValueOnce([{ timestamp: 2, value: 2 }]);

    const { result, rerender } = renderHook(
      ({ query }) => useTimeline({ query, range: RANGE }),
      { initialProps: { query: QUERY } },
    );
    await waitFor(() => assert.equal(timelineOf.mock.calls.length, 1));
    rerender({ query: OTHER });
    await waitFor(() => assert.equal(result.current.timeline.length, 1));

    await act(async () => {
      first.settle([{ timestamp: 1, value: 1 }]);
      await first.promise;
    });
    assert.deepEqual(result.current.timeline, [{ timestamp: 2, value: 2 }]);
  });
});
