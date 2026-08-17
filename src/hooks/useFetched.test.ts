import { act, renderHook, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { useFetched } from './useFetched.ts';

// The one fetch primitive every data hook is built on, so the protocol it
// promises is pinned here rather than only through its callers.

describe('useFetched', () => {
  it('runs the loader closure belonging to the deps it keyed on', async () => {
    // The loader is a fresh closure every render and is reached through a
    // ref, so a mis-ordered ref update would fetch with the previous deps
    // while the effect was keyed on the new ones — the request and the state
    // it lands in would disagree, invisibly.
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ q }) =>
        useFetched(
          '',
          true,
          async () => {
            seen.push(q);
            return q;
          },
          [q],
        ),
      { initialProps: { q: 'a' } },
    );
    await waitFor(() => assert.equal(seen.length, 1));
    rerender({ q: 'b' });
    await waitFor(() => assert.equal(seen.length, 2));
    rerender({ q: 'c' });
    await waitFor(() => assert.equal(seen.length, 3));
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  it('never reports idle while a fetch for the current deps is due', async () => {
    // Effects run after the commit, so there is a render between a deps
    // change and the fetch starting. Reporting "not loading" there paints the
    // previous (or empty) data as though it were the answer for the new deps.
    const fetching: boolean[] = [];
    let settle!: (value: string) => void;

    const { result, rerender } = renderHook(
      ({ q }) => {
        const state = useFetched(
          '',
          true,
          () =>
            new Promise<string>((resolve) => {
              settle = resolve;
            }),
          [q],
        );
        fetching.push(state.fetching);
        return state;
      },
      { initialProps: { q: 'a' } },
    );

    settle('first');
    await waitFor(() => assert.equal(result.current.data, 'first'));
    assert.equal(result.current.fetching, false);

    fetching.length = 0;
    rerender({ q: 'b' });
    // Every render from the deps change until the response lands.
    assert.ok(
      fetching.every((value) => value),
      `reported idle with a fetch due: ${JSON.stringify(fetching)}`,
    );

    settle('second');
    await waitFor(() => assert.equal(result.current.data, 'second'));
    assert.equal(result.current.fetching, false);
  });

  it('stays idle and never fetches while inactive', () => {
    let calls = 0;
    const { result } = renderHook(() =>
      useFetched(
        'initial',
        false,
        async () => {
          calls++;
          return 'fetched';
        },
        ['a'],
      ),
    );
    assert.equal(result.current.fetching, false);
    assert.equal(result.current.data, 'initial');
    assert.equal(calls, 0);
  });

  it('treats undefined and null deps as the same value', async () => {
    // A documented limitation of comparing deps by their JSON form: inside an
    // array both serialize to `null`. Every caller passes strings, finite
    // numbers, or a `string | undefined` that never takes null — this pins
    // the boundary so a future caller does not learn it the hard way.
    const calls: string[] = [];
    const { rerender } = renderHook(
      ({ t }: { t: string | undefined | null }) =>
        useFetched(
          0,
          true,
          async () => {
            calls.push(String(t));
            return calls.length;
          },
          ['x', t],
        ),
      { initialProps: { t: undefined as string | undefined | null } },
    );
    await waitFor(() => assert.equal(calls.length, 1));

    rerender({ t: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);

    rerender({ t: 'team-b' });
    await waitFor(() => assert.equal(calls.length, 2));
  });

  it('returns to initial when active flips false after a successful fetch', async () => {
    // A cleared query (active turns false) must not keep showing the last
    // profile fetched while it was set — that is a stale flamegraph with no
    // loading or error indication telling the user why.
    const { result, rerender } = renderHook(
      ({ active }) =>
        useFetched('initial', active, async () => 'fetched', ['a']),
      { initialProps: { active: true } },
    );
    await waitFor(() => assert.equal(result.current.data, 'fetched'));

    rerender({ active: false });
    assert.equal(result.current.data, 'initial');
    assert.equal(result.current.fetching, false);
  });

  it('drops to initial, not the previous key data, once the new key fetch fails', async () => {
    // Deps moving from A to B while B's fetch fails must not leave A's data
    // on screen next to B's error — the two belong to different queries.
    let fail!: (reason: unknown) => void;
    const { result, rerender } = renderHook(
      ({ q }) =>
        useFetched(
          'initial',
          true,
          async () => {
            if (q === 'a') return 'a-data';
            return new Promise<string>((_resolve, reject) => {
              fail = reject;
            });
          },
          [q],
        ),
      { initialProps: { q: 'a' } },
    );
    await waitFor(() => assert.equal(result.current.data, 'a-data'));

    rerender({ q: 'b' });
    await waitFor(() => assert.equal(result.current.fetching, true));
    fail(new Error('boom'));
    await waitFor(() => assert.equal(result.current.fetchError, 'boom'));
    assert.equal(result.current.data, 'initial');
  });

  it('keeps the previous key data on screen while the next key fetch is in flight', async () => {
    // Stale-while-refetching: the spinner for B shows next to A's last
    // answer, not a blank slate, until B's fetch settles one way or another.
    let settle!: (value: string) => void;
    const { result, rerender } = renderHook(
      ({ q }) =>
        useFetched(
          'initial',
          true,
          async () => {
            if (q === 'a') return 'a-data';
            return new Promise<string>((resolve) => {
              settle = resolve;
            });
          },
          [q],
        ),
      { initialProps: { q: 'a' } },
    );
    await waitFor(() => assert.equal(result.current.data, 'a-data'));

    rerender({ q: 'b' });
    await waitFor(() => assert.equal(result.current.fetching, true));
    assert.equal(result.current.data, 'a-data');

    settle('b-data');
    await waitFor(() => assert.equal(result.current.data, 'b-data'));
  });

  it('clears the error and reports loading through the gap when retry succeeds', async () => {
    // Reuses the same clear-on-new-fetch path a deps change gets (`run`
    // clears `fetchError` unconditionally), and pins the runId invariant:
    // `retry()` only bumps `attempt`, and `key` never changes for a retry,
    // so a naive `started !== key` comparison would report idle for every
    // render in this gap instead of catching that a run is due.
    let calls = 0;
    let settle!: (value: string) => void;
    const fetching: boolean[] = [];

    const { result } = renderHook(() => {
      const state = useFetched<string>(
        'initial',
        true,
        async () => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return new Promise<string>((resolve) => {
            settle = resolve;
          });
        },
        ['a'],
      );
      fetching.push(state.fetching);
      return state;
    });
    await waitFor(() => assert.equal(result.current.fetchError, 'boom'));
    assert.equal(result.current.fetching, false);

    fetching.length = 0;
    act(() => {
      result.current.retry();
    });
    assert.ok(
      fetching.every((value) => value),
      `reported idle with a retry due: ${JSON.stringify(fetching)}`,
    );
    assert.equal(result.current.fetchError, null);

    // Not wrapped in `act`: `waitFor` already handles flushing, and nesting
    // it inside an `act` callback deadlocks — the update `waitFor` polls for
    // only flushes once that callback returns.
    settle('recovered');
    await waitFor(() => assert.equal(result.current.data, 'recovered'));
    assert.equal(result.current.fetching, false);
    assert.equal(result.current.fetchError, null);
  });

  it('keeps the current key data on screen while a retry is in flight', async () => {
    // Stale-while-refetching applies to retries too: `dataKey` is keyed by
    // `key` alone, so a retry of the same key must not blank the previous
    // answer for it while the reload is in flight.
    let calls = 0;
    let settle!: (value: string) => void;

    const { result } = renderHook(() =>
      useFetched<string>(
        'initial',
        true,
        async () => {
          calls++;
          if (calls === 1) return 'a-data';
          return new Promise<string>((resolve) => {
            settle = resolve;
          });
        },
        ['a'],
      ),
    );
    await waitFor(() => assert.equal(result.current.data, 'a-data'));

    act(() => {
      result.current.retry();
    });
    assert.equal(result.current.fetching, true);
    assert.equal(result.current.data, 'a-data');

    settle('a-data-2');
    await waitFor(() => assert.equal(result.current.data, 'a-data-2'));
    assert.equal(result.current.fetching, false);
  });

  it('does not paint a superseded key’s error during the gap before its successor’s effect runs', async () => {
    // Bug: fetchError was cleared only inside run() (a passive effect, after
    // paint). Deps moving from A (failed) to B (pending) leave a render
    // between the deps change and that effect where `fetching` is already
    // true for B but `fetchError` still held A's failure — painting A's
    // error in B's place for one frame.
    let failA!: (reason: unknown) => void;
    let settleB!: (value: string) => void;
    const errors: (string | null)[] = [];

    const { result, rerender } = renderHook(
      ({ q }) => {
        const state = useFetched<string>(
          'initial',
          true,
          async () => {
            if (q === 'a') {
              return new Promise<string>((_resolve, reject) => {
                failA = reject;
              });
            }
            return new Promise<string>((resolve) => {
              settleB = resolve;
            });
          },
          [q],
        );
        errors.push(state.fetchError);
        return state;
      },
      { initialProps: { q: 'a' } },
    );

    await waitFor(() => assert.ok(failA));
    act(() => failA(new Error('boom')));
    await waitFor(() => assert.equal(result.current.fetchError, 'boom'));

    errors.length = 0;
    rerender({ q: 'b' });
    // Every render captured while switching to B — the pre-effect gap
    // included — must not still be reporting A's error.
    assert.ok(
      errors.every((value) => value === null),
      `painted a superseded key's error: ${JSON.stringify(errors)}`,
    );

    settleB('b-data');
    await waitFor(() => assert.equal(result.current.data, 'b-data'));
  });

  it('still surfaces a same-key retry’s error once it lands', async () => {
    // errorKey is scoped by `key`, not `runId`, so unlike a deps change, a
    // retry of the same key must keep showing that key's error once its
    // effect has run — only a *different* key gets suppressed during the
    // gap.
    let calls = 0;
    const { result } = renderHook(() =>
      useFetched<string>(
        'initial',
        true,
        async () => {
          calls++;
          throw new Error(`boom-${calls}`);
        },
        ['a'],
      ),
    );
    await waitFor(() => assert.equal(result.current.fetchError, 'boom-1'));

    act(() => {
      result.current.retry();
    });
    await waitFor(() => assert.equal(result.current.fetchError, 'boom-2'));
  });

  it('reports settled as false until the first run completes, true after a success', async () => {
    // A startup gate ("has the first answer arrived yet") reads `settled`,
    // not `fetching` — see the header comment.
    let settle!: (value: string) => void;
    const { result } = renderHook(() =>
      useFetched(
        'initial',
        true,
        () => new Promise<string>((resolve) => (settle = resolve)),
        ['a'],
      ),
    );
    assert.equal(result.current.settled, false);

    settle('first');
    await waitFor(() => assert.equal(result.current.data, 'first'));
    assert.equal(result.current.settled, true);
  });

  it('reports settled as true once the first run completes with a failure', async () => {
    // A run that fails is still a completed run — the caller has an answer
    // (an error), not nothing.
    const { result } = renderHook(() =>
      useFetched<string>(
        'initial',
        true,
        async () => {
          throw new Error('boom');
        },
        ['a'],
      ),
    );
    assert.equal(result.current.settled, false);
    await waitFor(() => assert.equal(result.current.fetchError, 'boom'));
    assert.equal(result.current.settled, true);
  });

  it('keeps settled true across a key change and refetch, even while the new key is still in flight', async () => {
    // The whole point of `settled`: a caller that gates a startup placeholder
    // on it must not see that gate re-open on a later, ordinary refetch (a
    // deps change, an auto-refresh tick).
    let settleA!: (value: string) => void;
    let settleB!: (value: string) => void;
    const { result, rerender } = renderHook(
      ({ q }) =>
        useFetched(
          'initial',
          true,
          () =>
            new Promise<string>((resolve) => {
              if (q === 'a') settleA = resolve;
              else settleB = resolve;
            }),
          [q],
        ),
      { initialProps: { q: 'a' } },
    );
    assert.equal(result.current.settled, false);
    settleA('a-data');
    await waitFor(() => assert.equal(result.current.data, 'a-data'));
    assert.equal(result.current.settled, true);

    rerender({ q: 'b' });
    // Still in flight for the new key — settled must stay true throughout.
    await waitFor(() => assert.equal(result.current.fetching, true));
    assert.equal(result.current.settled, true);

    settleB('b-data');
    await waitFor(() => assert.equal(result.current.data, 'b-data'));
    assert.equal(result.current.settled, true);
  });

  it('returns a referentially stable retry function across rerenders', async () => {
    // The lead's contract requires this so a downstream effect can sit
    // `retry` in its deps without churning on every render.
    const { result, rerender } = renderHook(
      ({ q }) => useFetched('initial', true, async () => q, [q]),
      { initialProps: { q: 'a' } },
    );
    await waitFor(() => assert.equal(result.current.data, 'a'));
    const first = result.current.retry;

    rerender({ q: 'a' });
    assert.equal(result.current.retry, first);

    rerender({ q: 'b' });
    await waitFor(() => assert.equal(result.current.data, 'b'));
    assert.equal(result.current.retry, first);
  });
});
