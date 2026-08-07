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
const DIR = fileURLToPath(new URL('fixtures/', import.meta.url));
const PREFIX = '/querier.v1.QuerierService/';

const read = (name) => readFileSync(`${DIR}${name}`, 'utf8');

const fixtures = {
  Series: read('Series.json'),
  LabelNames: read('LabelNames.json'),
  LabelValues: read('LabelValues.json'),
  SelectMergeStacktraces: read('SelectMergeStacktraces.json'),
  SelectSeries: read('SelectSeries.json'),
  'SelectSeries.grouped': read('SelectSeries.grouped.json'),
  Diff: read('Diff.json'),
};
const noTenant = read('no-tenant.txt');

// What the suite asserts against when it needs to know a request really
// carried something — the tenant header, say, through the Go proxy.
const log = [];

const body = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
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
  const request = JSON.parse((await body(req)) || '{}');
  log.push({
    method,
    tenant: tenant ?? null,
    groupBy: request.groupBy ?? null,
  });

  // The tenancy probe: an empty org id is what the UI sends to find out
  // whether this server wants one.
  if (tenant === '') return json(401, noTenant);

  const key =
    method === 'SelectSeries' && request.groupBy
      ? 'SelectSeries.grouped'
      : method;
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
  console.log(`fake pyroscope on http://127.0.0.1:${PORT}`);
});
