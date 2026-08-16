import { renderHook, waitFor } from '@testing-library/react';
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
});
