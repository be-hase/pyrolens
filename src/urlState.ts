import { useSyncExternalStore } from 'react';

// Minimal history-backed URL state. The URL is the single source of truth for
// all view state (tenant, query, time ranges, ...) so any screen can be shared
// by copying the address bar.

export interface Route {
  path: string;
  params: URLSearchParams;
}

const NAV_EVENT = 'pyroscope:navigate';

function basePath(): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return base === '/' ? '' : base.replace(/\/$/, '');
}

function currentPath(): string {
  const prefix = basePath();
  let path = window.location.pathname;
  // Segment-boundary match: under a base of /lens, /lenses/... is not ours
  // and must not be sliced into the non-route "es/...".
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
    path = path.slice(prefix.length);
  }
  return path === '' ? '/' : path;
}

let cachedRoute: Route | null = null;
let cachedHref = '';

function getRoute(): Route {
  const href = window.location.href;
  if (!cachedRoute || cachedHref !== href) {
    cachedRoute = {
      path: currentPath(),
      params: new URLSearchParams(window.location.search),
    };
    cachedHref = href;
  }
  return cachedRoute;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute);
}

export interface NavigateOptions {
  /** Target path; defaults to the current path. */
  path?: string;
  /** Params to set; null/undefined values are removed. Existing params are kept. */
  set?: Record<string, string | null | undefined>;
  /** Use history.replaceState instead of pushState. */
  replace?: boolean;
  /**
   * Marks this navigation as caused by an auto-refresh tick, not a user
   * action. Set ONLY by RefreshPicker's interval firing (and its
   * visibility-return refresh — same background cadence, just triggered by
   * the tab regaining focus instead of the timer). Every other navigate()
   * call in the app — Run, a param edit, a link, Back/Forward — must leave
   * this unset; see `useTickNavigation`'s doctrine below for why that
   * distinction exists and how a caller is expected to use it.
   */
  tick?: boolean;
}

export function buildUrl(opts: NavigateOptions): string {
  const path = opts.path ?? currentPath();
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(opts.set ?? {})) {
    if (value == null) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return `${basePath()}${path}${qs ? `?${qs}` : ''}`;
}

// Notification channel for the tick store below, deliberately separate from
// `pyroscope:navigate`/`popstate` (what `subscribe`/`useRoute` above run
// on). `useTickNavigation` used to piggyback on that same channel, but a
// reload that never navigates at all — `useFetched`'s `retry()` — still has
// to be able to clear the flag, and forcing that through a fake navigate()
// call would advance "now" (`advancesNow` below) and refire every fetch on
// screen just to mark one reload as user-caused. `markUserReload` notifies
// this channel directly instead.
const tickListeners = new Set<() => void>();

function notifyTick(): void {
  for (const cb of tickListeners) cb();
}

function subscribeTick(cb: () => void): () => void {
  tickListeners.add(cb);
  return () => {
    tickListeners.delete(cb);
  };
}

// Whether the current reload was caused by a tick (see NavigateOptions.tick).
// Read only through `useTickNavigation`; written by navigate(), the popstate
// listener below, and `markUserReload`.
let lastNavigationWasTick = false;

// The URL as of the last navigate()/popstate this module processed, so both
// can diff against it through `advancesNow`. Mirrors App.tsx's identical
// `prevNavUrl`/`bumpNow` tracker — deliberately duplicated rather than
// shared. App's tracker decides when to advance "now" for relative-range
// resolution, a view-layer concern; this one decides only whether a
// navigation could have caused a reload at all, a question urlState.ts
// already owns via `advancesNow`. Wiring the two together would couple this
// module to App's `nowVersion` machinery for no shared benefit.
let prevTickUrl: UrlLike = {
  pathname: window.location.pathname,
  search: window.location.search,
};

export function navigate(opts: NavigateOptions): void {
  const url = buildUrl(opts);
  // A navigation that changes nothing must still fire the event — that is
  // what makes Run a real refresh for a relative range — but it must not
  // stack a history entry, or five presses of Run cost five Backs to undo
  // and each one refetches on the way past. Comparing against the raw
  // `location.search` is not the same test: buildUrl's URLSearchParams
  // round trip normalises encoding (`%20` becomes `+`, param order can
  // shift), so an externally-encoded deep link made a no-op navigation (an
  // auto-refresh tick, say) look like a change and push a spurious history
  // entry. Re-serializing the current URL through buildUrl the same way
  // (`buildUrl({})`) makes both sides go through the identical
  // normalisation, so only an actual param change trips it.
  const unchanged = url === buildUrl({});
  if (opts.replace || unchanged) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
    pushGeneration += 1;
  }
  // The tick flag records the cause of the CURRENT reload, not of the most
  // recent navigation — a navigation that cannot itself cause a reload (a
  // view-only param settling: the flame graph search debounce, a sandwich
  // toggle, a sort click) must leave it alone, or it would wrongly re-arm
  // the dim/placeholder for the rest of a still-in-flight tick-caused
  // reload it had nothing to do with. `advancesNow` already answers exactly
  // this question for App.tsx's "now" bump, for the same reason a view-only
  // change doesn't refetch either — reused here rather than re-derived.
  const nextTickUrl: UrlLike = {
    pathname: window.location.pathname,
    search: window.location.search,
  };
  if (advancesNow(prevTickUrl, nextTickUrl)) {
    lastNavigationWasTick = !!opts.tick;
  }
  prevTickUrl = nextTickUrl;
  notifyTick();
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Doctrine: an auto-refresh tick is background activity — it must not
 * visually interrupt what's already on screen. A view uses this to tell a
 * tick-caused reload apart from a user-caused one (Run, a param edit,
 * Back/Forward, a Retry click) and suppress the reload-dim / loading-
 * placeholder swap for the former while still refetching and still showing
 * the panel meta's own "Loading…" (LoadingMeta) — the one indicator that's
 * expected to keep firing on every reload, ticks included.
 *
 * A consumer composes it as `(loading && !useTickNavigation()) || startupGap`
 * — not the other way around — because a startup gap (the services fetch
 * never having settled, a default-query write still due) can never itself
 * be tick-caused: a tick is skipped while a fetch it triggered is still in
 * flight (AGENTS.md), and the very first load is never a navigation at all.
 * Relying on that implicitly instead of composing it explicitly would leave
 * the placeholder logic correct by accident rather than by construction.
 *
 * The flag reflects the cause of the *current* reload, so it is updated —
 * set or cleared — only by a navigation `advancesNow` judges could itself
 * cause one; a view-only navigate() or popstate (fgSearch settling, a
 * sandwich toggle, a sort click) leaves it exactly as it was. Otherwise a
 * fetch-irrelevant write landing mid-tick-reload would flip it back to
 * false and re-arm the dim for the remainder of a reload that is still, in
 * fact, tick-caused — the exact noise this doctrine exists to remove.
 *
 * Also cleared by `markUserReload()`, for a reload that never navigates at
 * all (`useFetched`'s `retry()`), and by a fetch-relevant `popstate`
 * (Back/Forward is always the user's own action). With auto-refresh armed,
 * the flag's steady state between ticks is `true` (the last navigation was
 * the previous tick), so anything that causes a user-initiated reload
 * without going through `navigate()` must clear it explicitly, or it
 * silently inherits the tick's suppression.
 *
 * Caveat: RefreshPicker's `fetchesInFlight() > 0` guard closes most, not
 * all, of the window where a tick could stamp a reload it didn't actually
 * cause. Between `navigate()` returning and the fetch's own passive effect
 * starting (a couple of microtasks), `fetchesInFlight()` can still read 0;
 * a timer due in that exact gap fires, sees nothing in flight yet, and
 * marks a reload that happens to start in the same instant as tick-caused —
 * suppressing its dim for that one reload. Rare (a few-millisecond window)
 * and self-correcting on the next reload; not worth a mechanism change.
 */
export function useTickNavigation(): boolean {
  return useSyncExternalStore(subscribeTick, () => lastNavigationWasTick);
}

/**
 * Marks the reload about to start as user-caused, for a reload that never
 * calls `navigate()` at all — `useFetched`'s `retry()` is the one caller.
 * Clears the tick flag and notifies `useTickNavigation` subscribers directly
 * through the tick store's own channel, without dispatching
 * `pyroscope:navigate`: doing that would advance "now" (`advancesNow`) and
 * refire every relative-range fetch on screen just to mark one retry as
 * user-caused, which is not what a Retry click means.
 */
export function markUserReload(): void {
  lastNavigationWasTick = false;
  notifyTick();
}

// Bumped on every push-shaped navigation — a real `pushState` above (not a
// replace, and not the "nothing changed" case that quietly downgrades to
// one) — and on a browser `popstate` (Back/Forward). Both are the moments
// the user's context deliberately moves to a different point in history; a
// replace is not one of those, on purpose — a background writer settling
// (the flame graph search debounce, a stale-groupBy correction) must not
// look like a context switch, or unrelated background writers could cancel
// each other's legitimate work.
//
// A consumer with its own debounced commit (MaxNodesControl,
// useFlameGraphUrlState) captures this number at the moment the user's
// intent diverges from what's committed (a slider drag, a keystroke), and
// compares it again when the debounce would finally write: if it moved, the
// edit was decided in a context that no longer exists — a Reset, a Back, a
// deep link landing mid-debounce — and must not land in the new one. Same
// family of staleness rule as the `t v` clipboard guard (AGENTS.md): a
// settled read is only good for the context it was captured in.
let pushGeneration = 0;
export function pushGenerationNow(): number {
  return pushGeneration;
}
window.addEventListener('popstate', () => {
  pushGeneration += 1;
  // Mirrors navigate()'s identical advancesNow gate above: Back/Forward
  // only overrides the tick flag when the popped navigation could itself
  // cause a reload. A view-only popstate — landing back on an entry that
  // differs only by fgSearch, say — must not re-arm the dim over a reload
  // that is still, in fact, tick-caused.
  const nextTickUrl: UrlLike = {
    pathname: window.location.pathname,
    search: window.location.search,
  };
  if (advancesNow(prevTickUrl, nextTickUrl)) {
    lastNavigationWasTick = false;
  }
  prevTickUrl = nextTickUrl;
  notifyTick();
});

/**
 * Params whose value only changes how already-fetched data is rendered —
 * never what is fetched or what is sent to the server. A param may be added
 * here ONLY under that condition: no fetch and no server request may depend
 * on it. Listing a data-relevant param here silently kills refresh for it —
 * a fetch keyed on it would go stale and never be told to re-run.
 */
export const VIEW_ONLY_PARAMS: ReadonlySet<string> = new Set([
  'fgSearch', // flame graph search filter, applied client-side (useFlameGraphUrlState)
  'fgSandwich', // flame graph sandwich focus, applied client-side (useFlameGraphUrlState)
  'sort', // Tag Explorer table sort, applied client-side (sortRows, TagExplorerView)
]);

interface UrlLike {
  pathname: string;
  search: string;
}

/** Keys whose value differs between two query strings, multi-value aware. */
function changedParamKeys(prevSearch: string, nextSearch: string): Set<string> {
  const prev = new URLSearchParams(prevSearch);
  const next = new URLSearchParams(nextSearch);
  const changed = new Set<string>();
  for (const key of new Set([...prev.keys(), ...next.keys()])) {
    const prevValues = prev.getAll(key);
    const nextValues = next.getAll(key);
    const same =
      prevValues.length === nextValues.length &&
      prevValues.every((v, i) => v === nextValues[i]);
    if (!same) changed.add(key);
  }
  return changed;
}

/**
 * Whether a navigation from `prev` to `next` should advance the frozen "now"
 * snapshot App.tsx resolves relative ranges against (and so refire every
 * range-keyed fetch). A pathname change is always a real navigation. A
 * search-param diff of nothing is also a real navigation — that is what
 * makes Run/an auto-refresh tick a real refresh for a relative range, and
 * must not regress. Otherwise it advances unless every changed key (added,
 * removed, or value-changed) is in `VIEW_ONLY_PARAMS` — filtering data
 * that's already on screen is not a refresh.
 */
export function advancesNow(prev: UrlLike, next: UrlLike): boolean {
  if (prev.pathname !== next.pathname) return true;
  const changed = changedParamKeys(prev.search, next.search);
  if (changed.size === 0) return true;
  for (const key of changed) {
    if (!VIEW_ONLY_PARAMS.has(key)) return true;
  }
  return false;
}

/** Intercepts plain left-clicks on internal links so they use pushState. */
export function onLinkClick(
  opts: NavigateOptions,
): (e: React.MouseEvent<HTMLAnchorElement>) => void {
  return (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    navigate(opts);
  };
}
