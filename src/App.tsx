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
import { NavBar } from '@components/NavBar';
import { TenantDialog } from '@components/TenantDialog';
import { useServices } from '@hooks/useServices';
import { buildQuery } from './queryLang';
import {
  DEFAULT_FROM,
  DEFAULT_UNTIL,
  resolveRange,
  type TimeRange,
} from './time';
import { navigate, useRoute } from './urlState';
import { ComparisonView } from './views/ComparisonView';
import { DiffView } from './views/DiffView';
import { SingleView } from './views/SingleView';
import { TagExplorerView } from './views/TagExplorerView';

// Props shared by every top-level view. The URL is the single source of
// truth; App resolves the params once and hands the values down.
export interface ViewProps {
  services: Service[];
  servicesLoading: boolean;
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
// navigation — including a Run that leaves the URL unchanged, so pressing
// Run always re-resolves a relative range and refetches — and stays
// constant between navigations so renders are pure.
let nowCache = Date.now();
let nowVersion = 0;
let nowSeenVersion = 0;

function bumpNow(): void {
  nowVersion += 1;
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
    localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
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

  // Tenant remembered from the previous visit (read once at app load).
  const [storedTenant] = useState(() => localStorage.getItem(TENANT_KEY));

  // URL without a tenant but one remembered: adopt it, writing it into the
  // URL (replace) so the address stays the single source of truth.
  useEffect(() => {
    if (status === 'multi' && !tenant && storedTenant) {
      navigate({ set: { tenant: storedTenant }, replace: true });
    }
  }, [status, tenant, storedTenant]);

  // Remember the active tenant for the next visit.
  useEffect(() => {
    if (status === 'multi' && tenant) localStorage.setItem(TENANT_KEY, tenant);
  }, [status, tenant]);

  const showTenantDialog =
    status === 'multi' && ((!tenant && !storedTenant) || changingTenant);

  const query = params.get('query') ?? '';
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
    error: servicesError,
  } = useServices({
    range,
    tenantID,
    enabled: ready,
  });

  // No query in the URL yet: default to the first service and its preferred
  // profile type, written back into the URL (replace, so Back still works).
  useEffect(() => {
    if (!ready || query || services.length === 0) return;
    const first = services[0];
    const profileType = sortProfileTypes(first.profileTypes)[0];
    if (!profileType) return;
    navigate({
      set: { query: buildQuery(first.name, profileType) },
      replace: true,
    });
  }, [ready, query, services]);

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
      ) : (
        ready && (
          <>
            {servicesError && (
              <div className="app-error app-error-page">
                <p>Failed to load the service list.</p>
                <p className="app-error-detail">{servicesError}</p>
              </div>
            )}
            <ErrorBoundary key={path}>
              <View
                services={services}
                servicesLoading={servicesLoading}
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
            navigate({ set: { tenant: t }, replace: !tenant });
          }}
        />
      )}
    </div>
  );
}
