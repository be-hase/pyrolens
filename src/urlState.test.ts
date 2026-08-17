import { act, renderHook } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import {
  advancesNow,
  buildUrl,
  navigate,
  onLinkClick,
  useRoute,
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
