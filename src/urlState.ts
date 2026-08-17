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
  if (opts.replace || unchanged) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAV_EVENT));
}

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
