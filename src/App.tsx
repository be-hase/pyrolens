import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import {
  checkMultitenancy,
  setTenant,
  sortProfileTypes,
  type Service,
} from '@api/client';
import { ErrorBoundary } from '@components/ErrorBoundary';
import { Loading } from '@components/core/Loading';
import { NavBar } from '@components/NavBar';
import { TenantDialog } from '@components/TenantDialog';
import { useServices } from '@hooks/useServices';
import { buildQuery, defaultQueryPending } from './queryLang';
import { readStorage, writeStorage } from './storage';
import {
  DEFAULT_FROM,
  DEFAULT_UNTIL,
  resolveRange,
  type TimeRange,
} from './time';
import { advancesNow, navigate, useRoute } from './urlState';
import { ComparisonView } from './views/ComparisonView';
import { DiffView } from './views/DiffView';
import { SingleView } from './views/SingleView';
import { TagExplorerView } from './views/TagExplorerView';

// Props shared by every top-level view. The URL is the single source of
// truth; App resolves the params once and hands the values down.
export interface ViewProps {
  services: Service[];
  servicesLoading: boolean;
  /**
   * True once the services fetch has completed at least once since mount —
   * see useServices/useFetched. Views use this (via `defaultQueryPending`,
   * queryLang.ts) to gate startup-only placeholders instead of
   * `servicesLoading`, which pulses true again on every auto-refresh tick.
   */
  servicesSettled: boolean;
  /** Query selector from the `query` URL param ('' when unset). */
  query: string;
  /** Raw `from` URL value: relative ("now-1h") or unix milliseconds. */
  from: string;
  /** Raw `until` URL value: "now" or unix milliseconds. */
  until: string;
  /** `from`/`until` resolved to unix milliseconds. */
  range: TimeRange;
  /** Set only in multi-tenant mode; also retriggers fetches on switch. */
  tenantID?: string;
}

type Theme = 'dark' | 'light';
type TenantStatus = 'checking' | 'single' | 'multi' | 'error';

const THEME_KEY = 'pyrolens:theme';
const TENANT_KEY = 'pyrolens:tenant';

interface ViewDef {
  key: string;
  View: ComponentType<ViewProps>;
}

const VIEWS: Record<string, ViewDef | undefined> = {
  '/': { key: 'single', View: SingleView },
  '/comparison': { key: 'comparison', View: ComparisonView },
  '/diff': { key: 'diff', View: DiffView },
  '/explore': { key: 'explore', View: TagExplorerView },
};

const DEFAULT_VIEW: ViewDef = { key: 'single', View: SingleView };

// The API client's X-Scope-OrgID header follows the `tenant` URL param.
// Synced outside React — at module load and on every URL change (urlState
// dispatches 'pyroscope:navigate' after pushState) — so it is already
// current when any data-fetching effect runs.
function syncTenantFromUrl(): void {
  setTenant(
    new URLSearchParams(window.location.search).get('tenant') ?? undefined,
  );
}
syncTenantFromUrl();
window.addEventListener('popstate', syncTenantFromUrl);
window.addEventListener('pyroscope:navigate', syncTenantFromUrl);

// "Now" used to resolve relative time ranges. It advances on every
// navigation except one whose only change is a view-only param
// (VIEW_ONLY_PARAMS in urlState.ts, e.g. the flame graph search) — that
// includes a Run that leaves the URL unchanged, so pressing Run always
// re-resolves a relative range and refetches, but excludes a write that only
// changes how already-fetched data is rendered, which is not a refresh. It
// stays constant between navigations so renders are pure.
let nowCache = Date.now();
let nowVersion = 0;
let nowSeenVersion = 0;
// The URL as of the last navigate/popstate event, so bumpNow can diff
// against it. Updated on every event regardless of the decision below, or
// the next event would be diffed against a stale prev and could wrongly
// look like a no-op (empty diff -> advance) or wrongly absorb a real change
// into an already-seen one.
let prevNavUrl = {
  pathname: window.location.pathname,
  search: window.location.search,
};

function bumpNow(): void {
  const nextNavUrl = {
    pathname: window.location.pathname,
    search: window.location.search,
  };
  if (advancesNow(prevNavUrl, nextNavUrl)) {
    nowVersion += 1;
  }
  prevNavUrl = nextNavUrl;
}
window.addEventListener('popstate', bumpNow);
window.addEventListener('pyroscope:navigate', bumpNow);

function nowSnapshot(): number {
  if (nowVersion !== nowSeenVersion) {
    nowSeenVersion = nowVersion;
    nowCache = Date.now();
  }
  return nowCache;
}

function subscribeNow(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener('pyroscope:navigate', cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener('pyroscope:navigate', cb);
  };
}

export function App() {
  const { path, params } = useRoute();
  const { key: activeView, View } = VIEWS[path] ?? DEFAULT_VIEW;

  const [theme, setTheme] = useState<Theme>(() =>
    readStorage(THEME_KEY) === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    writeStorage(THEME_KEY, theme);
  }, [theme]);

  // One probe on load decides single- vs multi-tenant (or "server is down").
  const [status, setStatus] = useState<TenantStatus>('checking');
  const [probeError, setProbeError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkMultitenancy()
      .then((multi) => {
        if (!cancelled) setStatus(multi ? 'multi' : 'single');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setProbeError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tenant = params.get('tenant') ?? undefined;
  const tenantID = status === 'multi' ? tenant : undefined;
  const [changingTenant, setChangingTenant] = useState(false);

  // A shared link can carry `?tenant=bar` from a multitenant deployment. If
  // the probe here comes back single-tenant, that tenant must not keep
  // riding along on every request — under an allowlisted upstream it would
  // 403 every fetch, and single-tenant mode has no tenant UI to recover
  // from that. Stripping it with a replace-navigation fires the
  // module-level `pyroscope:navigate` listener (`syncTenantFromUrl`)
  // synchronously, so the API client's tenant is cleared before the next
  // fetch runs.
  useEffect(() => {
    if (status === 'single' && tenant) {
      navigate({ set: { tenant: null }, replace: true });
    }
  }, [status, tenant]);

  // Tenant remembered from the previous visit (read once at app load).
  const [storedTenant] = useState(() => readStorage(TENANT_KEY));

  // URL without a tenant but one remembered: adopt it, writing it into the
  // URL (replace) so the address stays the single source of truth.
  useEffect(() => {
    if (status === 'multi' && !tenant && storedTenant) {
      navigate({ set: { tenant: storedTenant }, replace: true });
    }
  }, [status, tenant, storedTenant]);

  // Remember the active tenant for the next visit.
  useEffect(() => {
    if (status === 'multi' && tenant) writeStorage(TENANT_KEY, tenant);
  }, [status, tenant]);

  const showTenantDialog =
    status === 'multi' && ((!tenant && !storedTenant) || changingTenant);

  // `null` (no param at all) and `''` (the user cleared it) are different:
  // only the former gets a default written in, or Run on an empty query bar
  // would be undone by the default-query effect below and the field could
  // never be cleared.
  const rawQuery = params.get('query');
  const query = rawQuery ?? '';
  const from = params.get('from') ?? DEFAULT_FROM;
  const until = params.get('until') ?? DEFAULT_UNTIL;
  // Memoized so the resolved range object only moves on URL change.
  const nowMs = useSyncExternalStore(subscribeNow, nowSnapshot);
  const range = useMemo(
    () => resolveRange(from, until, nowMs),
    [from, until, nowMs],
  );

  const ready = status === 'single' || (status === 'multi' && !!tenant);
  const {
    services,
    servicesLoading,
    servicesSettled,
    error: servicesError,
  } = useServices({
    range,
    tenantID,
    enabled: ready,
  });

  // No query in the URL yet: default to the first service and its preferred
  // profile type, written back into the URL (replace, so Back still works).
  // `queryDefaultDue` is the exact condition under which a write is DUE —
  // shared with every view's startup-gap flag (defaultQueryPending,
  // queryLang.ts) so neither side can drift from what "pending" means, and
  // that is correct for them as is: while a fetch is in flight they should
  // show Loading, "pending" or not.
  //
  // Due is not the same as safe to act ON, though. `services` is
  // stale-while-refetching (useFetched), so right after a tenant switch
  // (which resets `query` to nothing) it still holds the OLD tenant's list
  // while the NEW tenant's fetch is in flight — `queryDefaultDue` reads true
  // from that stale list, and writing from it would default the new tenant
  // into a service that named the old one's world. This effect additionally
  // waits for `!servicesLoading`, i.e. for the list to be current for the
  // present `tenantID`, before it may write.
  const queryDefaultDue = defaultQueryPending(services, rawQuery);
  useEffect(() => {
    if (!ready || !queryDefaultDue || servicesLoading) return;
    const first = services[0];
    const profileType = sortProfileTypes(first.profileTypes)[0];
    if (!profileType) return;
    navigate({
      set: { query: buildQuery(first.name, profileType) },
      replace: true,
    });
  }, [ready, queryDefaultDue, services, servicesLoading]);

  return (
    <div className="app">
      <NavBar
        activeView={activeView}
        theme={theme}
        onThemeChange={setTheme}
        tenantID={tenantID}
        onChangeTenant={
          status === 'multi' ? () => setChangingTenant(true) : undefined
        }
      />
      {status === 'error' ? (
        <div className="app-error app-error-page">
          <p>
            Failed to reach Pyroscope at {window.location.origin}. Check that
            the server is running, then reload this page.
          </p>
          {probeError && <p className="app-error-detail">{probeError}</p>}
        </div>
      ) : status === 'checking' ? (
        // The one probe on load (checkMultitenancy) hasn't settled yet, so
        // there is neither an error nor a view to show — rendering nothing
        // here used to leave the content area blank for as long as the probe
        // took, reading as a broken page rather than one that's working.
        <Loading />
      ) : (
        ready && (
          <>
            {servicesError && (
              <div className="app-error app-error-page">
                <p>Failed to load the service list.</p>
                <p className="app-error-detail">{servicesError}</p>
              </div>
            )}
            <ErrorBoundary key={path} resetKey={params.toString()}>
              <View
                services={services}
                servicesLoading={servicesLoading}
                servicesSettled={servicesSettled}
                query={query}
                from={from}
                until={until}
                range={range}
                tenantID={tenantID}
              />
            </ErrorBoundary>
          </>
        )
      )}
      {showTenantDialog && (
        <TenantDialog
          initial={tenant ?? storedTenant ?? undefined}
          onSubmit={(t: string) => {
            setChangingTenant(false);
            if (t === tenant) {
              // Resubmitting the current tenant is a cancel, not a Run: even
              // a no-op navigate() would advance "now" and refire every
              // fetch, which closing the dialog must not do.
              return;
            }
            if (!tenant) {
              // Initial pick (first dialog on load): a deep link to a
              // multi-tenant instance carries params meant for the tenant
              // about to be entered, so keep them.
              navigate({ set: { tenant: t }, replace: true });
              return;
            }
            // Real switch: reset the whole URL, not just its params. The old
            // tenant's params (query, groupBy, pane overrides, fgSearch,
            // ...) name that tenant's world and make no sense against the
            // new one, and the view itself may be mid-flight on data (a
            // pane's query, a sandwich focus) that means nothing for a
            // tenant that hasn't been looked at yet — so land back on the
            // root view too. Push (not replace) so Back restores the
            // previous tenant with its full context, view included.
            navigate({
              path: '/',
              set: {
                ...Object.fromEntries([...params.keys()].map((k) => [k, null])),
                tenant: t,
              },
            });
          }}
        />
      )}
    </div>
  );
}
