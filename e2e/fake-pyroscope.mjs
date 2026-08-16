// Replays the captured Pyroscope responses (e2e/fixtures, see capture.mjs)
// so the e2e suite gets the same bytes on every run.
//
// The real binary proxies to this, which keeps the whole chain under test —
// browser, Go proxy, decoder, canvas — while leaving the data fixed. It
// behaves like a multitenant server: a request carrying an explicitly empty
// X-Scope-OrgID is refused, which is what the UI's probe reads.
//
//   PORT=4142 node e2e/fake-pyroscope.mjs

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 4142);
// A server without -auth.multitenancy-enabled answers the probe instead of
// refusing it, and the UI then shows no tenant anything at all.
const MULTITENANT = process.env.MULTITENANT !== '0';
const DIR = fileURLToPath(new URL('fixtures/', import.meta.url));
const PREFIX = '/querier.v1.QuerierService/';

const read = (name) => readFileSync(`${DIR}${name}`, 'utf8');

const fixtures = {
  Series: read('Series.json'),
  LabelNames: read('LabelNames.json'),
  LabelValues: read('LabelValues.json'),
  SelectMergeStacktraces: read('SelectMergeStacktraces.json'),
  'SelectMergeStacktraces.empty': read('SelectMergeStacktraces.empty.json'),
  SelectSeries: read('SelectSeries.json'),
  'SelectSeries.grouped': read('SelectSeries.grouped.json'),
  'SelectSeries.empty': read('SelectSeries.empty.json'),
  Diff: read('Diff.json'),
};
const noTenant = read('no-tenant.txt');
const { service, noTenantStatus } = JSON.parse(read('meta.json'));

// What the suite asserts against when it needs to know a request really
// carried something — the tenant header, say, through the Go proxy.
const log = [];

const body = (req) =>
  new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
    // Without this, a connection reset mid-body leaves the promise pending
    // forever rather than rejecting — the request that caused it hangs, and
    // nothing else in the process is affected, but it should fail fast.
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  if (req.url === '/__log') {
    if (req.method === 'DELETE') {
      log.length = 0;
      return json(200, '[]');
    }
    return json(200, JSON.stringify(log));
  }

  if (!req.url.startsWith(PREFIX)) {
    res.writeHead(404).end('not found');
    return;
  }

  const method = req.url.slice(PREFIX.length);
  const tenant = req.headers['x-scope-orgid'];
  let request;
  try {
    request = JSON.parse((await body(req)) || '{}');
  } catch {
    // A malformed body used to throw here uncaught: createServer's handler
    // is async, so that became an unhandled rejection that killed the whole
    // process (and every test still running against it) instead of failing
    // just the one request.
    return json(400, JSON.stringify({ code: 'invalid_argument' }));
  }
  // Enough of the request for a spec to assert what was actually asked for.
  // With only the method and the tenant here, a regression that queried the
  // wrong profile type or the wrong window still replayed the same fixture
  // and every view rendered correctly.
  log.push({
    method,
    tenant: tenant ?? null,
    groupBy: request.groupBy ?? null,
    profileTypeID: request.profileTypeID ?? request.left?.profileTypeID ?? null,
    labelSelector: request.labelSelector ?? request.left?.labelSelector ?? null,
    start: request.start ?? request.left?.start ?? null,
    end: request.end ?? request.left?.end ?? null,
    step: request.step ?? null,
    name: request.name ?? null,
    limit: request.limit ?? null,
    // SelectMergeStacktraces carries maxNodes at the top level; Diff nests
    // it inside each side's query object instead (see the wire-shape
    // comment in src/api/client.ts), so both are logged separately rather
    // than folding them into one field that could hide a placement bug.
    maxNodes: request.maxNodes ?? null,
    leftMaxNodes: request.left?.maxNodes ?? null,
    rightMaxNodes: request.right?.maxNodes ?? null,
  });

  // The tenancy probe: an empty org id is what the UI sends to find out
  // whether this server wants one. The status replayed is whatever the real
  // server gave at capture time (meta.json), not a hardcoded 401 — the two
  // have drifted from each other before.
  if (tenant === '' && MULTITENANT) return json(noTenantStatus, noTenant);

  // A selector naming some other service gets the empty answer the server
  // really gives, so the UI's "no data" state is reachable on purpose rather
  // than only during the moment before a response lands.
  const selector = request.labelSelector ?? request.left?.labelSelector ?? '';
  const matches = !selector || selector.includes(service);

  let key = method;
  if (method === 'SelectSeries' && request.groupBy)
    key = 'SelectSeries.grouped';
  if (!matches && fixtures[`${method}.empty`]) key = `${method}.empty`;
  const fixture = fixtures[key];
  if (!fixture) {
    return json(
      404,
      JSON.stringify({ code: 'unimplemented', message: method }),
    );
  }
  json(200, fixture);
});

server.listen(PORT, '127.0.0.1', () => {
  const mode = MULTITENANT ? 'multitenant' : 'single-tenant';
  console.log(`fake pyroscope on http://127.0.0.1:${PORT} (${mode})`);
});
