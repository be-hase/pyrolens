import { Button } from '@components/core/Button';
import { buildQuery, parseQuery } from '../queryLang';
import { buildUrl, navigate, useRoute } from '../urlState';

/**
 * A view's own materialized defaults, keyed by URL param — TagExplorerView's
 * `groupBy` is the only one today (App.tsx's `query` default is handled
 * separately, below, since it also has to survive a service/profile_type
 * change). A key mapped to a string means "this is the real default, known
 * right now" and the reset target carries that value instead of clearing
 * the param. A key mapped to `undefined` means the default isn't known yet
 * (e.g. TagExplorerView's labels fetch hasn't settled) — that key is
 * excluded from both the reset-set and the visibility comparison entirely,
 * neither cleared nor asserted, because there is nothing to judge it
 * against yet.
 */
export type ResetDefaults = Record<string, string | undefined>;

/**
 * The params a click would write. Reads straight from `window.location`
 * (the same source `buildUrl` itself reads), rather than taking params as an
 * argument — so this and the navigation it drives can never disagree about
 * what "current" means.
 *
 * Mirrors App.tsx's tenant-switch reset: every CURRENT param is cleared
 * first — so a param added anywhere else in the app is swept up here for
 * free, never needing its own line — then `tenant` and `query` are re-set.
 * `query` is reduced to exactly `buildQuery(service_name, profile_type)`,
 * using queryLang's own shared parse+format pair (`parseQuery`/`buildQuery`,
 * the same two every other query-writing control goes through); a query
 * that doesn't parse, or is missing one of the two, has nothing left worth
 * keeping, so it is cleared entirely and App's default-query effect
 * (`defaultQueryPending`) takes back over.
 *
 * `defaults` (see {@link ResetDefaults}) then overrides individual keys: a
 * known default replaces the generic "clear it" with "set it to this", and
 * an unknown one is deleted from the result outright — a view materializing
 * its own default (TagExplorerView's groupBy) would otherwise see this
 * button clear it, only to have its own effect immediately rewrite the same
 * value back in, an infinite-looking push/rewrite cycle and a button that
 * can never hide.
 */
function resetParams(
  defaults: ResetDefaults = {},
): Record<string, string | null | undefined> {
  const params = new URLSearchParams(window.location.search);
  const parsed = parseQuery(params.get('query') ?? '');
  const set: Record<string, string | null | undefined> = {
    ...Object.fromEntries([...params.keys()].map((k) => [k, null])),
    tenant: params.get('tenant') ?? undefined,
    query: parsed ? buildQuery(parsed.service, parsed.profileType) : null,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) delete set[key];
    else set[key] = value;
  }
  return set;
}

/**
 * Whether `resetParams()` would actually change the URL — the same "only
 * show an override" rule ComparisonPane's "Reset window" button uses.
 * Reuses `buildUrl`'s own no-op test (`urlState.ts`'s `navigate`) rather
 * than re-deriving "is this different" by hand, so the button's visibility
 * and what a click actually does can never drift apart.
 */
function hasNonDefaultState(defaults?: ResetDefaults): boolean {
  return buildUrl({ set: resetParams(defaults) }) !== buildUrl({});
}

// Clears every URL param a session of fiddling with the UI can accumulate —
// the time range, refresh, groupBy, sort, the flame graph search/sandwich,
// maxNodes, both comparison panes' overrides, and any extra label matcher
// inside `query` — while keeping the data identity: tenant, the current view
// (the pathname is untouched; only params move), and the query reduced to
// service_name/profile_type. Renders nothing when there is nothing to reset.
// Self-contained like MaxNodesControl: nothing else needs these params
// threaded through as props, so it reads the route itself — `defaults` is
// the one exception, since a materialized default (TagExplorerView's
// groupBy) is only known to the view that writes it.
export function ResetViewButton({
  defaults,
}: {
  /** See {@link ResetDefaults}. Omitted by views with nothing like this. */
  defaults?: ResetDefaults;
}) {
  // Subscribes to navigation so the component re-renders when the URL
  // changes; resetParams()/hasNonDefaultState() re-read window.location
  // fresh on every render rather than trusting a stale closure over it.
  useRoute();
  if (!hasNonDefaultState(defaults)) return null;
  return (
    <Button
      icon="history-alt"
      aria-label="Reset view"
      title="Back to defaults — keeps the service, profile type and tenant"
      // A push, not a replace: Back has to restore the state being reset
      // away, the same reasoning as App.tsx's tenant-switch reset.
      onClick={() => navigate({ set: resetParams(defaults) })}
    >
      Reset
    </Button>
  );
}
