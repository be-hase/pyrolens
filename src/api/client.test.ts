import assert from 'node:assert/strict';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from 'vitest';
import {
  checkMultitenancy,
  fetchDiffFlamegraph,
  fetchesInFlight,
  fetchFlamegraph,
  fetchGroupedTimelines,
  fetchLabelNames,
  fetchLabelValues,
  fetchServices,
  fetchTimeline,
  profileTypeLabel,
  profileTypeUnit,
  setTenant,
  sortProfileTypes,
} from './client.ts';

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const MEM = 'memory:alloc_space:bytes:space:bytes';
const GOROUTINES = 'goroutines:goroutine:count:goroutine:count';

// --- fetch stub --------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal?: AbortSignal | null;
}

let calls: Call[] = [];
// Promise-returning too, so fetchesInFlight tests can hold a request open.
let reply: (call: Call) => Response | Promise<Response>;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  reply = () => json({});
});

// The tenant lives in a module-level variable, so a leaked one would ride
// along on every later test's requests.
afterEach(() => setTenant(undefined));

const only = () => {
  assert.equal(calls.length, 1);
  return calls[0];
};

// --- profile types -----------------------------------------------------------

describe('profileTypeUnit', () => {
  it('reads the sample unit out of the type ID', () => {
    assert.equal(profileTypeUnit(CPU), 'ns');
    assert.equal(profileTypeUnit(MEM), 'bytes');
    assert.equal(profileTypeUnit(GOROUTINES), 'count');
  });

  it('falls back to count for anything unrecognized', () => {
    assert.equal(profileTypeUnit(''), 'count');
    assert.equal(profileTypeUnit('garbage'), 'count');
    assert.equal(profileTypeUnit('a:b:microseconds:d:e'), 'count');
  });
});

describe('profileTypeLabel', () => {
  it('shows the sample type', () => {
    assert.equal(profileTypeLabel(CPU), 'cpu');
    assert.equal(profileTypeLabel(MEM), 'alloc_space');
  });

  it('falls back to the whole ID when there is no sample type', () => {
    assert.equal(profileTypeLabel('weird'), 'weird');
    assert.equal(profileTypeLabel('a::c'), 'a::c');
  });
});

describe('sortProfileTypes', () => {
  it('puts cpu first, then orders by label', () => {
    const sorted = sortProfileTypes([MEM, GOROUTINES, CPU]);
    assert.deepEqual(sorted.map(profileTypeLabel), [
      'cpu',
      'alloc_space',
      'goroutine',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [MEM, CPU];
    sortProfileTypes(input);
    assert.deepEqual(input, [MEM, CPU]);
  });

  it('breaks a display-name tie deterministically by the full ID', () => {
    // process_cpu and wall both label "cpu"; a stable sort alone would let
    // the upstream Series order decide, so two servers (or two responses)
    // could hand out a different default query.
    const WALL = 'wall:cpu:nanoseconds:cpu:nanoseconds';
    assert.deepEqual(sortProfileTypes([WALL, CPU]), [CPU, WALL]);
    assert.deepEqual(sortProfileTypes([CPU, WALL]), [CPU, WALL]);
  });
});

// --- transport ---------------------------------------------------------------

describe('rpc transport', () => {
  it('POSTs JSON to the connect path for the method', async () => {
    reply = () => json({ names: [] });
    await fetchLabelNames(['{}'], 1, 2);
    const call = only();
    assert.equal(call.url, '/querier.v1.QuerierService/LabelNames');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(call.body, { start: 1, end: 2, matchers: ['{}'] });
  });

  it('omits the tenant header in single-tenant mode', async () => {
    reply = () => json({ names: [] });
    await fetchLabelNames(['{}'], 1, 2);
    assert.equal(only().headers.has('X-Scope-OrgID'), false);
  });

  it('sends the tenant header once one is set', async () => {
    setTenant('team-a');
    reply = () => json({ names: [] });
    await fetchLabelNames(['{}'], 1, 2);
    assert.equal(only().headers.get('X-Scope-OrgID'), 'team-a');
  });

  it('treats an empty tenant as unset', async () => {
    setTenant('team-a');
    setTenant('');
    reply = () => json({ names: [] });
    await fetchLabelNames(['{}'], 1, 2);
    assert.equal(only().headers.has('X-Scope-OrgID'), false);
  });

  it('forwards the abort signal so superseded requests are cancelled', async () => {
    const controller = new AbortController();
    reply = () => json({ names: [] });
    await fetchLabelValues('region', ['{}'], 1, 2, controller.signal);
    assert.equal(only().signal, controller.signal);
  });

  it('surfaces the server message on an error response', async () => {
    reply = () =>
      json({ code: 'invalid_argument', message: 'parse error at line 1' }, 400);
    await assert.rejects(fetchLabelNames(['{}'], 1, 2), {
      message: 'parse error at line 1',
    });
  });

  it('falls back to the status when the error body is not JSON', async () => {
    reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    await assert.rejects(fetchLabelNames(['{}'], 1, 2), {
      message: 'LabelNames failed: HTTP 502',
    });
  });

  it('falls back to the status when the error JSON has no message', async () => {
    reply = () => json({ code: 'internal' }, 500);
    await assert.rejects(fetchLabelNames(['{}'], 1, 2), {
      message: 'LabelNames failed: HTTP 500',
    });
  });
});

// --- in-flight tracking --------------------------------------------------

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

describe('fetchesInFlight', () => {
  it('is 0 at rest', () => {
    assert.equal(fetchesInFlight(), 0);
  });

  it('counts a pending rpc, then drops back to 0 once it resolves', async () => {
    const pending = deferred<Response>();
    reply = () => pending.promise;

    const call = fetchLabelNames(['{}'], 1, 2);
    // The fetch stub's promise chain needs a turn of the microtask queue to
    // register the call before the counter reflects it.
    await Promise.resolve();
    assert.equal(fetchesInFlight(), 1);

    pending.settle(json({ names: [] }));
    await call;
    assert.equal(fetchesInFlight(), 0);
  });

  it('drops back to 0 after a rejection too', async () => {
    const pending = deferred<Response>();
    reply = () => pending.promise;

    const call = fetchLabelNames(['{}'], 1, 2);
    await Promise.resolve();
    assert.equal(fetchesInFlight(), 1);

    pending.settle(json({ code: 'internal' }, 500));
    await assert.rejects(call);
    assert.equal(fetchesInFlight(), 0);
  });
});

// --- tenancy probe -----------------------------------------------------------

describe('checkMultitenancy', () => {
  it('probes with an explicitly empty tenant', async () => {
    setTenant('team-a');
    reply = () => json({ names: [] });
    await checkMultitenancy();
    assert.equal(only().headers.get('X-Scope-OrgID'), '');
  });

  it('reports single-tenant when the probe succeeds', async () => {
    reply = () => json({ names: [] });
    assert.equal(await checkMultitenancy(), false);
  });

  it('reports multi-tenant when the server asks for an org id', async () => {
    reply = () => new Response('no org id provided', { status: 401 });
    assert.equal(await checkMultitenancy(), true);
    reply = () => new Response('missing tenant ID', { status: 400 });
    assert.equal(await checkMultitenancy(), true);
  });

  it('reports single-tenant for an unrelated error', async () => {
    reply = () =>
      new Response('bad request: malformed matcher', { status: 400 });
    assert.equal(await checkMultitenancy(), false);
  });

  it('rejects on a gateway error, which is an outage not a verdict', async () => {
    for (const status of [502, 503, 504]) {
      reply = () => new Response('upstream pyroscope unreachable', { status });
      await assert.rejects(checkMultitenancy(), {
        message: 'upstream pyroscope unreachable',
      });
    }
  });

  it('names the status when the gateway error has no body', async () => {
    reply = () => new Response('', { status: 503 });
    await assert.rejects(checkMultitenancy(), {
      message: 'upstream error (HTTP 503)',
    });
  });
});

// --- services ----------------------------------------------------------------

describe('fetchServices', () => {
  const labelsSet = (...pairs: [string, string][][]) => ({
    labelsSet: pairs.map((labels) => ({
      labels: labels.map(([name, value]) => ({ name, value })),
    })),
  });

  it('asks for the two labels it derives services from', async () => {
    reply = () => json(labelsSet());
    await fetchServices(1, 2);
    assert.deepEqual(only().body, {
      start: 1,
      end: 2,
      matchers: ['{}'],
      labelNames: ['service_name', '__profile_type__'],
    });
  });

  it('groups profile types per service and sorts by name', async () => {
    reply = () =>
      json(
        labelsSet(
          [
            ['service_name', 'web'],
            ['__profile_type__', CPU],
          ],
          [
            ['service_name', 'api'],
            ['__profile_type__', CPU],
          ],
          [
            ['service_name', 'web'],
            ['__profile_type__', MEM],
          ],
        ),
      );
    assert.deepEqual(await fetchServices(1, 2), [
      { name: 'api', profileTypes: [CPU] },
      { name: 'web', profileTypes: [CPU, MEM] },
    ]);
  });

  it('deduplicates repeated profile types', async () => {
    reply = () =>
      json(
        labelsSet(
          [
            ['service_name', 'web'],
            ['__profile_type__', CPU],
          ],
          [
            ['service_name', 'web'],
            ['__profile_type__', CPU],
          ],
        ),
      );
    assert.deepEqual(await fetchServices(1, 2), [
      { name: 'web', profileTypes: [CPU] },
    ]);
  });

  it('skips label sets missing either label', async () => {
    reply = () =>
      json(
        labelsSet(
          [['service_name', 'web']],
          [['__profile_type__', CPU]],
          [
            ['service_name', ''],
            ['__profile_type__', CPU],
          ],
        ),
      );
    assert.deepEqual(await fetchServices(1, 2), []);
  });

  it('tolerates an empty response', async () => {
    reply = () => json({});
    assert.deepEqual(await fetchServices(1, 2), []);
  });
});

// --- flamegraphs -------------------------------------------------------------

const QUERY = {
  profileTypeID: CPU,
  labelSelector: '{service_name="web"}',
  start: 1,
  end: 2,
};

describe('fetchFlamegraph', () => {
  it('normalizes connect int64 strings to numbers', async () => {
    reply = () =>
      json({
        flamegraph: {
          names: ['total', 'main'],
          levels: [{ values: ['0', '100', '0', '0'] }],
          total: '100',
          maxSelf: '40',
        },
      });
    assert.deepEqual(await fetchFlamegraph(QUERY), {
      names: ['total', 'main'],
      levels: [[0, 100, 0, 0]],
      total: 100,
      maxSelf: 40,
    });
  });

  it('accepts values already sent as numbers', async () => {
    reply = () =>
      json({
        flamegraph: { names: ['a'], levels: [{ values: [0, 1, 0, 0] }] },
      });
    const data = await fetchFlamegraph(QUERY);
    assert.deepEqual(data.levels, [[0, 1, 0, 0]]);
  });

  it('returns an empty profile when the server sends none', async () => {
    reply = () => json({});
    assert.deepEqual(await fetchFlamegraph(QUERY), {
      names: [],
      levels: [],
      total: 0,
      maxSelf: 0,
    });
  });
});

describe('fetchDiffFlamegraph', () => {
  it('sends both sides and keeps values as strings', async () => {
    reply = () =>
      json({
        flamegraph: {
          names: ['total'],
          levels: [{ values: [0, '100', 0, 0, '80', 0, 0] }],
        },
      });
    const data = await fetchDiffFlamegraph(QUERY, { ...QUERY, start: 3 });
    assert.deepEqual(only().body, {
      left: QUERY,
      right: { ...QUERY, start: 3 },
    });
    assert.deepEqual(data, {
      names: ['total'],
      levels: [{ values: ['0', '100', '0', '0', '80', '0', '0'] }],
    });
  });

  it('returns an empty profile when the server sends none', async () => {
    reply = () => json({});
    assert.deepEqual(await fetchDiffFlamegraph(QUERY, QUERY), {
      names: [],
      levels: [],
    });
  });
});

// --- timelines ---------------------------------------------------------------

const series = (
  labels: Record<string, string>,
  points: [number, number][],
) => ({
  labels: Object.entries(labels).map(([name, value]) => ({ name, value })),
  points: points.map(([timestamp, value]) => ({
    timestamp: String(timestamp),
    value: String(value),
  })),
});

describe('fetchTimeline', () => {
  it('returns the single series with numeric points', async () => {
    reply = () =>
      json({
        series: [
          series({}, [
            [1000, 5],
            [2000, 7],
          ]),
        ],
      });
    assert.deepEqual(await fetchTimeline({ ...QUERY, step: 15 }), [
      { timestamp: 1000, value: 5 },
      { timestamp: 2000, value: 7 },
    ]);
  });

  it('sums several series per timestamp, in time order', async () => {
    reply = () =>
      json({
        series: [
          series({ pod: 'a' }, [
            [2000, 7],
            [1000, 5],
          ]),
          series({ pod: 'b' }, [
            [1000, 1],
            [3000, 2],
          ]),
        ],
      });
    assert.deepEqual(await fetchTimeline({ ...QUERY, step: 15 }), [
      { timestamp: 1000, value: 6 },
      { timestamp: 2000, value: 7 },
      { timestamp: 3000, value: 2 },
    ]);
  });

  it('returns nothing for an empty response', async () => {
    reply = () => json({});
    assert.deepEqual(await fetchTimeline({ ...QUERY, step: 15 }), []);
  });
});

describe('fetchGroupedTimelines', () => {
  it('requests the group-by label as a list', async () => {
    reply = () => json({ series: [] });
    await fetchGroupedTimelines({ ...QUERY, step: 15, groupBy: 'region' });
    assert.deepEqual(only().body, { ...QUERY, step: 15, groupBy: ['region'] });
  });

  it('orders groups by total descending', async () => {
    reply = () =>
      json({
        series: [
          series({ region: 'eu' }, [[1000, 3]]),
          series({ region: 'us' }, [
            [1000, 10],
            [2000, 1],
          ]),
        ],
      });
    const grouped = await fetchGroupedTimelines({
      ...QUERY,
      step: 15,
      groupBy: 'region',
    });
    assert.deepEqual(
      grouped.map((g) => g.labelValue),
      ['us', 'eu'],
    );
  });

  it('merges series sharing a label value', async () => {
    reply = () =>
      json({
        series: [
          series({ region: 'us', pod: 'a' }, [[1000, 4]]),
          series({ region: 'us', pod: 'b' }, [
            [1000, 6],
            [2000, 1],
          ]),
        ],
      });
    assert.deepEqual(
      await fetchGroupedTimelines({ ...QUERY, step: 15, groupBy: 'region' }),
      [
        {
          labelValue: 'us',
          points: [
            { timestamp: 1000, value: 10 },
            { timestamp: 2000, value: 1 },
          ],
        },
      ],
    );
  });

  it('maps series missing the group-by label to a null labelValue', async () => {
    reply = () =>
      json({
        series: [series({ pod: 'a' }, [[1000, 1]]), series({}, [[1000, 2]])],
      });
    assert.deepEqual(
      await fetchGroupedTimelines({ ...QUERY, step: 15, groupBy: 'region' }),
      [{ labelValue: null, points: [{ timestamp: 1000, value: 3 }] }],
    );
  });

  it('keeps a literal "(none)" value in its own bucket, not merged with missing', async () => {
    reply = () =>
      json({
        series: [
          series({ region: '(none)' }, [[1000, 5]]),
          series({}, [[1000, 2]]),
        ],
      });
    const grouped = await fetchGroupedTimelines({
      ...QUERY,
      step: 15,
      groupBy: 'region',
    });
    assert.deepEqual(grouped, [
      { labelValue: '(none)', points: [{ timestamp: 1000, value: 5 }] },
      { labelValue: null, points: [{ timestamp: 1000, value: 2 }] },
    ]);
  });

  it('returns every group, largest total first', async () => {
    // No truncation here: the Tag Explorer computes each group's share of
    // the total from this list, so dropping groups would inflate the shares.
    reply = () =>
      json({
        series: [
          series({ region: 'a' }, [[1000, 1]]),
          series({ region: 'b' }, [[1000, 9]]),
          series({ region: 'c' }, [[1000, 5]]),
        ],
      });
    const grouped = await fetchGroupedTimelines({
      ...QUERY,
      step: 15,
      groupBy: 'region',
    });
    assert.deepEqual(
      grouped.map((g) => g.labelValue),
      ['b', 'c', 'a'],
    );
  });
});

// --- labels ------------------------------------------------------------------

describe('fetchLabelNames / fetchLabelValues', () => {
  it('returns the names the server sent', async () => {
    reply = () => json({ names: ['region', 'pod'] });
    assert.deepEqual(await fetchLabelNames(['{}'], 1, 2), ['region', 'pod']);
  });

  it('sends the label name alongside the matchers', async () => {
    reply = () => json({ names: ['eu', 'us'] });
    assert.deepEqual(await fetchLabelValues('region', ['{a="b"}'], 1, 2), [
      'eu',
      'us',
    ]);
    assert.deepEqual(only().body, {
      name: 'region',
      start: 1,
      end: 2,
      matchers: ['{a="b"}'],
    });
  });

  it('returns nothing when the response omits names', async () => {
    reply = () => json({});
    assert.deepEqual(await fetchLabelNames(['{}'], 1, 2), []);
    assert.deepEqual(await fetchLabelValues('region', ['{}'], 1, 2), []);
  });
});
