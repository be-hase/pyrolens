// Connect-JSON client for the Pyroscope querier API.
//
// Every RPC is a POST to /querier.v1.QuerierService/<Method> with a JSON
// body; the Go server proxies these paths to the real Pyroscope, so all URLs
// are relative. Connect encodes int64 fields as JSON strings, so numeric
// fields coming off the wire are normalized with Number()/String() before
// they reach callers. Times are unix milliseconds throughout.

const BASE = '/querier.v1.QuerierService';

// --- Tenant plumbing ---------------------------------------------------------

let currentTenant: string | undefined;

/**
 * Sets the tenant sent as `X-Scope-OrgID` on every subsequent request.
 * Pass undefined (or '') to clear it (single-tenant mode).
 */
export function setTenant(tenant: string | undefined): void {
  currentTenant = tenant || undefined;
}

/**
 * Probes whether the backing Pyroscope requires a tenant. Sends a LabelNames
 * request with an explicitly empty `X-Scope-OrgID`: HTTP 200 means
 * single-tenant (resolves false); an error complaining about a missing
 * org/tenant id means multi-tenant (resolves true). Rejects only when the
 * server cannot be reached at all.
 */
export async function checkMultitenancy(): Promise<boolean> {
  const now = Date.now();
  const res = await fetch(`${BASE}/LabelNames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Scope-OrgID': '' },
    body: JSON.stringify({ start: now - 3_600_000, end: now }),
  });
  if (res.ok) return false;
  // Gateway errors mean Pyroscope itself is unreachable behind the bundled
  // proxy — that's an outage, not a tenancy verdict.
  if (res.status >= 502 && res.status <= 504) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `upstream error (HTTP ${res.status})`);
  }
  const body = await res.text().catch(() => '');
  return /org|tenant/i.test(body);
}

// --- Transport ---------------------------------------------------------------

// Count of rpc() calls currently in flight (started, not yet settled).
// Auto-refresh ticks on a fixed interval regardless of whether the fetch it
// started last time has finished; without this, a tick that outlives its
// interval (a large profile routinely does) gets its request aborted and
// reissued forever, so no fetch ever completes. RefreshPicker checks this
// before firing a tick and skips it while something it triggered is still
// outstanding. checkMultitenancy doesn't go through rpc() and isn't counted
// here — it runs once at startup, never on a timer.
let inFlight = 0;

/** Number of rpc() calls currently in flight. */
export function fetchesInFlight(): number {
  return inFlight;
}

async function rpc<T>(
  method: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  inFlight++;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (currentTenant) headers['X-Scope-OrgID'] = currentTenant;

    const res = await fetch(`${BASE}/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let message = `${method} failed: HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { message?: string };
        if (err.message) message = err.message;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  } finally {
    // Runs on abort and rejection too, so a cancelled or failed request
    // frees the slot just as promptly as a successful one.
    inFlight--;
  }
}

// Wire shapes (connect-JSON; int64 arrives as string).
interface WireLabel {
  name: string;
  value: string;
}
interface WirePoint {
  timestamp: number | string;
  value: number | string;
}
interface WireSeries {
  labels?: WireLabel[];
  points?: WirePoint[];
}
interface WireFlamegraph {
  names?: string[];
  levels?: { values?: (number | string)[] }[];
  total?: number | string;
  maxSelf?: number | string;
}

// --- Profile types -----------------------------------------------------------

// Profile type IDs have the form `name:sampleType:sampleUnit:periodType:periodUnit`,
// e.g. `process_cpu:cpu:nanoseconds:cpu:nanoseconds`.

export type ProfileUnit = 'ns' | 'bytes' | 'count';

/** Display unit for a profile type ID ('ns' values are nanoseconds). */
export function profileTypeUnit(profileTypeID: string): ProfileUnit {
  switch (profileTypeID.split(':')[2]) {
    case 'nanoseconds':
      return 'ns';
    case 'bytes':
      return 'bytes';
    default:
      return 'count';
  }
}

/** Short display name for a profile type ID (its sample type, e.g. "cpu"). */
export function profileTypeLabel(profileTypeID: string): string {
  return profileTypeID.split(':')[1] || profileTypeID;
}

/**
 * Byte order, not locale order. These lists decide which service and profile
 * type App writes into the URL as the default query, so a browser-dependent
 * collation would hand two colleagues different starting screens — and the
 * same rule that keeps `toLocale*` out of the UI applies to ordering.
 */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts profile type IDs for display: cpu first, then by label. */
export function sortProfileTypes(profileTypes: string[]): string[] {
  const rank = (id: string) => (profileTypeLabel(id) === 'cpu' ? 0 : 1);
  return [...profileTypes].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      byName(profileTypeLabel(a), profileTypeLabel(b)) ||
      // Two IDs can share a label (process_cpu and wall both say "cpu"); fall
      // back to the full ID so the default query doesn't depend on the
      // upstream Series order, which a stable sort would otherwise preserve.
      byName(a, b),
  );
}

// --- Services ----------------------------------------------------------------

export interface Service {
  name: string;
  profileTypes: string[];
}

/**
 * Lists services (sorted by name) with the profile type IDs each exposes,
 * derived from the `service_name` / `__profile_type__` labels of Series.
 */
export async function fetchServices(
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Service[]> {
  const res = await rpc<{ labelsSet?: { labels?: WireLabel[] }[] }>(
    'Series',
    {
      start,
      end,
      matchers: ['{}'],
      labelNames: ['service_name', '__profile_type__'],
    },
    signal,
  );

  const byService = new Map<string, Set<string>>();
  for (const set of res.labelsSet ?? []) {
    const service = set.labels?.find((l) => l.name === 'service_name')?.value;
    const type = set.labels?.find((l) => l.name === '__profile_type__')?.value;
    if (!service || !type) continue;
    const types = byService.get(service) ?? new Set<string>();
    types.add(type);
    byService.set(service, types);
  }

  return [...byService]
    .map(([name, types]) => ({ name, profileTypes: [...types] }))
    .sort((a, b) => byName(a.name, b.name));
}

// --- Flamegraphs -------------------------------------------------------------

export interface ProfileQuery {
  profileTypeID: string;
  labelSelector: string;
  start: number;
  end: number;
}

/**
 * Parses the `maxNodes` URL parameter: a positive integer capping the node
 * count per flamegraph query. The URL is user input, never "corrected" — a
 * value that isn't a clean positive integer in a sane range (absent, zero,
 * garbage, or implausibly huge) is treated as absent so the query falls back
 * to the server's own default rather than the client silently picking a
 * different number.
 */
export function parseMaxNodes(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 1_000_000 ? n : undefined;
}

/**
 * Single flamegraph in Pyroscope flamebearer format: `levels[i]` is a flat
 * number array in groups of 4 — offset (relative to the previous sibling's
 * end), total, self, name index into `names`.
 */
export interface FlamegraphData {
  names: string[];
  levels: number[][];
  total?: number;
  maxSelf?: number;
}

export async function fetchFlamegraph(
  params: ProfileQuery,
  maxNodes?: number,
  signal?: AbortSignal,
): Promise<FlamegraphData> {
  const res = await rpc<{ flamegraph?: WireFlamegraph }>(
    'SelectMergeStacktraces',
    // JSON.stringify drops an undefined-valued property, so an absent
    // maxNodes is simply not sent rather than sent as null/0 — the server
    // then applies its own default instead of reading a manufactured value.
    { ...params, maxNodes },
    signal,
  );
  const fg = res.flamegraph;
  return {
    names: fg?.names ?? [],
    levels: (fg?.levels ?? []).map((l) => (l.values ?? []).map(Number)),
    total: Number(fg?.total ?? 0),
    maxSelf: Number(fg?.maxSelf ?? 0),
  };
}

/**
 * Diff flamegraph in the "double" flamebearer format: `levels[i].values` is a
 * flat array in groups of 7 — offsetLeft, totalLeft, selfLeft, offsetRight,
 * totalRight, selfRight, nameIdx. Values are kept as strings (as sent on the
 * wire); consumers parse them.
 */
export interface DiffFlamegraphData {
  names: string[];
  levels: { values: string[] }[];
}

export async function fetchDiffFlamegraph(
  left: ProfileQuery,
  right: ProfileQuery,
  maxNodes?: number,
  signal?: AbortSignal,
): Promise<DiffFlamegraphData> {
  const res = await rpc<{ flamegraph?: WireFlamegraph }>(
    'Diff',
    // Diff nests two SelectMergeStacktraces-shaped requests (see the
    // "double" flamebearer comment on DiffFlamegraphData below) rather than
    // exposing one merged query, and the querier reads maxNodes per side —
    // there is no top-level field for it — so it goes on `left` and `right`
    // individually, not on the outer { left, right } envelope.
    { left: { ...left, maxNodes }, right: { ...right, maxNodes } },
    signal,
  );
  return {
    names: res.flamegraph?.names ?? [],
    levels: (res.flamegraph?.levels ?? []).map((l) => ({
      values: (l.values ?? []).map(String),
    })),
  };
}

// --- Timelines ---------------------------------------------------------------

export interface Point {
  /** Unix milliseconds. */
  timestamp: number;
  value: number;
}

function toPoints(points: WirePoint[] | undefined): Point[] {
  return (points ?? []).map((p) => ({
    timestamp: Number(p.timestamp),
    value: Number(p.value),
  }));
}

/** Timeline for a query; `step` is in seconds (see timelineStep). */
export async function fetchTimeline(
  params: ProfileQuery & { step: number },
  signal?: AbortSignal,
): Promise<Point[]> {
  const res = await rpc<{ series?: WireSeries[] }>(
    'SelectSeries',
    params,
    signal,
  );
  const series = res.series ?? [];
  // Sorted even in the single-series case: the multi-series path below merges
  // through a map and sorts, so leaving one series in wire order made the same
  // data draw a self-crossing line depending only on how many series arrived.
  if (series.length <= 1) {
    return toPoints(series[0]?.points).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  // No groupBy was requested, but the server returned several series: sum
  // them per timestamp so callers always see a single line.
  const byTs = new Map<number, number>();
  for (const s of series) {
    for (const p of toPoints(s.points)) {
      byTs.set(p.timestamp, (byTs.get(p.timestamp) ?? 0) + p.value);
    }
  }
  return [...byTs]
    .map(([timestamp, value]) => ({ timestamp, value }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export interface GroupedTimeline {
  /** null when the series lacked the group-by label entirely. */
  labelValue: string | null;
  points: Point[];
}

/**
 * One timeline per value of the `groupBy` label, ordered by total (sum of
 * point values) descending. Not truncated: callers slice for display, so
 * shares computed over the result cover every group.
 */
export async function fetchGroupedTimelines(
  params: ProfileQuery & { step: number; groupBy: string },
  signal?: AbortSignal,
): Promise<GroupedTimeline[]> {
  const { groupBy, ...rest } = params;
  const res = await rpc<{ series?: WireSeries[] }>(
    'SelectSeries',
    { ...rest, groupBy: [groupBy] },
    signal,
  );

  // Series can share a label value — merge them by summing per timestamp.
  // A missing label is kept as null rather than a sentinel string, so a
  // series whose label value is literally the string "(none)" lands in its
  // own bucket instead of merging with the ones that lack the label.
  const merged = new Map<string | null, Map<number, number>>();
  for (const s of res.series ?? []) {
    const labelValue = s.labels?.find((l) => l.name === groupBy)?.value ?? null;
    const bucket = merged.get(labelValue) ?? new Map<number, number>();
    for (const p of toPoints(s.points)) {
      bucket.set(p.timestamp, (bucket.get(p.timestamp) ?? 0) + p.value);
    }
    merged.set(labelValue, bucket);
  }
  const sum = (points: Point[]) => points.reduce((acc, p) => acc + p.value, 0);
  return [...merged]
    .map(([labelValue, bucket]) => ({
      labelValue,
      points: [...bucket]
        .map(([timestamp, value]) => ({ timestamp, value }))
        .sort((a, b) => a.timestamp - b.timestamp),
    }))
    .sort((a, b) => sum(b.points) - sum(a.points));
}

// --- Labels ------------------------------------------------------------------

export async function fetchLabelNames(
  matchers: string[],
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await rpc<{ names?: string[] }>(
    'LabelNames',
    { start, end, matchers },
    signal,
  );
  return res.names ?? [];
}

export async function fetchLabelValues(
  name: string,
  matchers: string[],
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await rpc<{ names?: string[] }>(
    'LabelValues',
    { name, start, end, matchers },
    signal,
  );
  return res.names ?? [];
}
