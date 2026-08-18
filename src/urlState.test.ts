import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import {
  advancesNow,
  buildUrl,
  markUserReload,
  navigate,
  onLinkClick,
  pushGenerationNow,
  useRoute,
  useTickNavigation,
} from './urlState.ts';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

/** A left click with no modifiers, as React reports it. */
const plainClick = () => {
  const e = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  };
  return e as unknown as React.MouseEvent<HTMLAnchorElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
};

describe('buildUrl', () => {
  it('keeps the current path when none is given', () => {
    window.history.replaceState(null, '', '/comparison');
    assert.equal(buildUrl({}), '/comparison');
  });

  it('carries existing params over', () => {
    window.history.replaceState(null, '', '/?query=%7B%7D&from=now-1h');
    assert.equal(buildUrl({ path: '/diff' }), '/diff?query=%7B%7D&from=now-1h');
  });

  it('sets and replaces params', () => {
    window.history.replaceState(null, '', '/?from=now-1h');
    assert.equal(
      buildUrl({ set: { from: 'now-6h', until: 'now' } }),
      '/?from=now-6h&until=now',
    );
  });

  it('removes params set to null or undefined', () => {
    window.history.replaceState(null, '', '/?from=now-1h&until=123');
    assert.equal(buildUrl({ set: { until: null } }), '/?from=now-1h');
    assert.equal(buildUrl({ set: { until: undefined } }), '/?from=now-1h');
  });

  it('omits the question mark when nothing is left', () => {
    window.history.replaceState(null, '', '/?from=now-1h');
    assert.equal(buildUrl({ set: { from: null } }), '/');
  });

  it('encodes values that would otherwise break the query string', () => {
    const url = buildUrl({ set: { query: '{service_name="a b", x="&y"}' } });
    assert.ok(!url.includes(' '), url);
    const params = new URLSearchParams(url.slice(url.indexOf('?')));
    assert.equal(params.get('query'), '{service_name="a b", x="&y"}');
  });
});

describe('navigate', () => {
  it('pushes a new history entry', () => {
    const before = window.history.length;
    navigate({ path: '/diff', set: { query: '{}' } });
    assert.equal(window.location.pathname, '/diff');
    assert.equal(
      new URLSearchParams(window.location.search).get('query'),
      '{}',
    );
    assert.ok(window.history.length > before);
  });

  it('does not stack an entry for a navigation that changes nothing', () => {
    // Pressing Run without editing anything is a refresh, not a new place:
    // it still has to fire the event (that is what re-resolves a relative
    // range), but five presses must not cost five presses of Back, each one
    // refetching on the way past.
    navigate({ path: '/diff', set: { query: '{a="b"}' } });
    const after = window.history.length;
    let events = 0;
    const count = () => events++;
    window.addEventListener('pyroscope:navigate', count);
    navigate({ set: { query: '{a="b"}' } });
    navigate({ set: { query: '{a="b"}' } });
    window.removeEventListener('pyroscope:navigate', count);

    assert.equal(window.history.length, after);
    assert.equal(events, 2);
  });

  it('replaces the entry when asked, so Back still works', () => {
    navigate({ set: { tenant: 'team-a' } });
    const after = window.history.length;
    navigate({ set: { tenant: 'team-b' }, replace: true });
    assert.equal(window.history.length, after);
    assert.equal(
      new URLSearchParams(window.location.search).get('tenant'),
      'team-b',
    );
  });

  it('treats a differently-encoded but equal URL as unchanged', () => {
    // A deep link can arrive with %20 where URLSearchParams would emit '+'
    // for the same value. Comparing buildUrl's re-serialization against the
    // raw, unnormalised location.search made a no-op navigation (an
    // auto-refresh tick, say) look like a real change and push a spurious
    // history entry.
    window.history.replaceState(null, '', '/?query=a%20b');
    const before = window.history.length;
    navigate({ set: {} });
    assert.equal(window.history.length, before);
  });

  it('announces itself so listeners outside React can react first', () => {
    // The tenant header is synced by a module-level listener on this event;
    // dropping it would let a request go out against the previous tenant.
    const seen: string[] = [];
    const listener = () => seen.push(window.location.search);
    window.addEventListener('pyroscope:navigate', listener);
    navigate({ set: { tenant: 'team-a' } });
    window.removeEventListener('pyroscope:navigate', listener);
    assert.deepEqual(seen, ['?tenant=team-a']);
  });
});

describe('pushGenerationNow', () => {
  it('bumps on a real push navigation', () => {
    const before = pushGenerationNow();
    navigate({ path: '/diff', set: { query: '{a="b"}' } });
    assert.equal(pushGenerationNow(), before + 1);
  });

  it('does not bump on a replace navigation', () => {
    navigate({ set: { tenant: 'team-a' } });
    const before = pushGenerationNow();
    navigate({ set: { tenant: 'team-b' }, replace: true });
    assert.equal(pushGenerationNow(), before);
  });

  it('does not bump on a navigation that changes nothing (downgraded to a replace)', () => {
    navigate({ path: '/diff', set: { query: '{a="b"}' } });
    const before = pushGenerationNow();
    navigate({ set: { query: '{a="b"}' } });
    assert.equal(pushGenerationNow(), before);
  });

  it('bumps on a browser Back (popstate)', async () => {
    navigate({ path: '/comparison' });
    const before = pushGenerationNow();
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      );
      window.history.back();
      await popped;
    });
    assert.equal(pushGenerationNow(), before + 1);
  });
});

describe('useTickNavigation', () => {
  beforeEach(() => {
    // A plain navigate() carries no tick option, so this settles the flag
    // back to false before each test regardless of what a previous test in
    // this file left it as — the flag is module state, not reset by the
    // top-level beforeEach's replaceState.
    navigate({ set: {} });
  });

  it('is false before any tick navigation', () => {
    const { result } = renderHook(() => useTickNavigation());
    assert.equal(result.current, false);
  });

  it('is true immediately after a tick navigation', () => {
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
  });

  it('is cleared by a subsequent non-tick navigation', () => {
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
    act(() => navigate({ path: '/diff', set: { query: '{a="b"}' } }));
    assert.equal(result.current, false);
  });

  it('is cleared by a no-op non-tick navigation too — a Run press right after a tick must not leave the marker set', () => {
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
    act(() => navigate({ set: {} }));
    assert.equal(result.current, false);
  });

  it('is cleared by popstate (Back/Forward)', async () => {
    act(() => navigate({ path: '/comparison' }));
    act(() => navigate({ set: {}, tick: true }));
    const { result } = renderHook(() => useTickNavigation());
    assert.equal(result.current, true);
    // History traversal, and the popstate the hook listens for, land on a
    // later turn — the real browser sequence, not a shortcut (mirrors
    // pushGenerationNow's identical Back test above).
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      );
      window.history.back();
      await popped;
    });
    assert.equal(result.current, false);
  });

  it('is left alone by a view-only navigation mid-tick-reload (fgSearch settling)', () => {
    // The flag records the cause of the CURRENT reload, not of the most
    // recent navigation. A view-only write (VIEW_ONLY_PARAMS — fgSearch,
    // fgSandwich, sort) never refetches, so it must not overwrite a tick
    // marker that's still describing an in-flight reload it had nothing to
    // do with — that was the exact regression this pins: a fetch-irrelevant
    // replace flipping the flag back to false and re-arming the dim/
    // placeholder for the rest of a still-tick-caused reload.
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
    act(() => navigate({ set: { fgSearch: 'alloc' } }));
    assert.equal(
      result.current,
      true,
      'a view-only write must not clear the tick marker',
    );
  });

  it('is still overwritten by a fetch-relevant navigation, even without a tick marker', () => {
    // Regression guard for the gate itself: a real (non-view-only) change
    // must still land as before — this is not a general "sticky until
    // explicitly cleared" flag.
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
    act(() => navigate({ set: { query: '{a="b"}' } }));
    assert.equal(result.current, false);
  });

  it('is left alone by a view-only popstate mid-tick-reload (fgSearch-only Back)', async () => {
    // Same gate as the navigate() case above, mirrored for Back/Forward: a
    // popped entry that differs from the current one only by a view-only
    // param must not re-arm the dim over a reload that is still, in fact,
    // tick-caused.
    act(() => navigate({ path: '/', set: { query: '{a="b"}' } })); // A: fetch-relevant push
    act(() => navigate({ set: { fgSearch: 'y' } })); // B: pushes a real entry, view-only diff from A
    act(() => navigate({ set: {}, tick: true })); // arm the marker (no-op nav at B, downgrades to replace)
    const { result } = renderHook(() => useTickNavigation());
    assert.equal(result.current, true);

    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      );
      window.history.back(); // back to A — differs from B only by fgSearch
      await popped;
    });
    assert.equal(
      result.current,
      true,
      'a view-only Back must not clear the tick marker',
    );
  });
});

describe('markUserReload', () => {
  beforeEach(() => {
    navigate({ set: {} });
  });

  it('clears an armed tick marker', () => {
    const { result } = renderHook(() => useTickNavigation());
    act(() => navigate({ set: {}, tick: true }));
    assert.equal(result.current, true);
    act(() => markUserReload());
    assert.equal(result.current, false);
  });

  it('notifies useTickNavigation without dispatching pyroscope:navigate', () => {
    // useFetched's retry() doesn't navigate at all — it must be able to
    // clear the marker without going through navigate(), which would
    // advance "now" (advancesNow) and refire every relative-range fetch on
    // screen just to mark one retry as user-caused.
    act(() => navigate({ set: {}, tick: true }));
    const { result } = renderHook(() => useTickNavigation());
    assert.equal(result.current, true);

    let navEvents = 0;
    const onNav = () => navEvents++;
    window.addEventListener('pyroscope:navigate', onNav);
    act(() => markUserReload());
    window.removeEventListener('pyroscope:navigate', onNav);

    assert.equal(result.current, false);
    assert.equal(
      navEvents,
      0,
      'markUserReload must not dispatch pyroscope:navigate',
    );
  });

  it('does not touch the URL or the push-generation counter', () => {
    const beforeUrl = window.location.href;
    const beforeGen = pushGenerationNow();
    act(() => markUserReload());
    assert.equal(window.location.href, beforeUrl);
    assert.equal(pushGenerationNow(), beforeGen);
  });
});

describe('useRoute', () => {
  it('reports the current path and params', () => {
    window.history.replaceState(null, '', '/explore?groupBy=region');
    const { result } = renderHook(() => useRoute());
    assert.equal(result.current.path, '/explore');
    assert.equal(result.current.params.get('groupBy'), 'region');
  });

  it('re-renders on navigate', () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate({ path: '/diff', set: { query: '{a="b"}' } }));
    assert.equal(result.current.path, '/diff');
    assert.equal(result.current.params.get('query'), '{a="b"}');
  });

  it('re-renders on Back', async () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate({ path: '/comparison' }));
    assert.equal(result.current.path, '/comparison');
    // History traversal, and the popstate the hook listens for, land on a
    // later turn — this is the real browser sequence, not a shortcut.
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      );
      window.history.back();
      await popped;
    });
    assert.equal(result.current.path, '/');
  });

  it('hands out a stable snapshot while the URL is unchanged', () => {
    // useSyncExternalStore re-reads on every render and loops if the snapshot
    // is a fresh object each time.
    const { result, rerender } = renderHook(() => useRoute());
    const first = result.current;
    rerender();
    assert.equal(result.current, first);
  });

  it('treats a bare path as the root', () => {
    window.history.replaceState(null, '', '?query=%7B%7D');
    const { result } = renderHook(() => useRoute());
    assert.equal(result.current.path, '/');
  });
});

describe('onLinkClick', () => {
  it('navigates in place instead of loading the page', () => {
    const e = plainClick();
    onLinkClick({ path: '/diff' })(e);
    assert.equal(e.preventDefault.mock.calls.length, 1);
    assert.equal(window.location.pathname, '/diff');
  });

  it('leaves modified clicks to the browser', () => {
    // Cmd/Ctrl/Shift-click opens a tab or window; hijacking those would make
    // the tabs feel broken.
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const e = { ...plainClick(), [modifier]: true } as ReturnType<
        typeof plainClick
      >;
      onLinkClick({ path: '/diff' })(e);
      assert.equal(e.preventDefault.mock.calls.length, 0, modifier);
      assert.equal(window.location.pathname, '/', modifier);
    }
  });

  it('leaves middle clicks to the browser', () => {
    const e = { ...plainClick(), button: 1 } as ReturnType<typeof plainClick>;
    onLinkClick({ path: '/diff' })(e);
    assert.equal(e.preventDefault.mock.calls.length, 0);
    assert.equal(window.location.pathname, '/');
  });
});

describe('advancesNow', () => {
  const at = (pathname: string, search: string) => ({ pathname, search });

  it('treats a pathname change as a real navigation', () => {
    assert.equal(
      advancesNow(at('/', '?query=a'), at('/diff', '?query=a')),
      true,
    );
  });

  it('treats a no-op navigation (same path, same params) as a real refresh', () => {
    // This is what makes Run/an auto-refresh tick a real refresh for a
    // relative range — it must not regress.
    assert.equal(
      advancesNow(
        at('/', '?query=a&from=now-1h'),
        at('/', '?query=a&from=now-1h'),
      ),
      true,
    );
  });

  it('does not advance for an fgSearch-only add', () => {
    assert.equal(
      advancesNow(at('/', '?query=a'), at('/', '?query=a&fgSearch=x')),
      false,
    );
  });

  it('does not advance for an fgSearch-only value change', () => {
    assert.equal(
      advancesNow(
        at('/', '?query=a&fgSearch=x'),
        at('/', '?query=a&fgSearch=y'),
      ),
      false,
    );
  });

  it('does not advance for an fgSearch-only removal', () => {
    assert.equal(
      advancesNow(at('/', '?query=a&fgSearch=x'), at('/', '?query=a')),
      false,
    );
  });

  it('advances when fgSearch changes alongside a data-relevant param', () => {
    assert.equal(
      advancesNow(
        at('/', '?query=a&fgSearch=x&from=now-1h'),
        at('/', '?query=a&fgSearch=y&from=now-6h'),
      ),
      true,
    );
  });

  it('does not advance for a sort-only change', () => {
    assert.equal(
      advancesNow(
        at('/explore', '?query=a'),
        at('/explore', '?query=a&sort=avg'),
      ),
      false,
    );
  });

  it('advances for a groupBy-only change (not view-only)', () => {
    assert.equal(
      advancesNow(
        at('/explore', '?query=a&groupBy=region'),
        at('/explore', '?query=a&groupBy=host'),
      ),
      true,
    );
  });

  it('treats a value-count change on a multi-valued param as a real change', () => {
    // Same key, same set of values, different multiplicity — a naive
    // set-based diff would miss this.
    assert.equal(advancesNow(at('/', '?tag=a'), at('/', '?tag=a&tag=a')), true);
  });
});
