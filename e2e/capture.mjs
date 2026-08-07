// Records the Pyroscope responses the e2e suite replays.
//
// The point of capturing rather than hand-writing them is that a fixture is
// only worth anything if it is what the server actually sends: a renamed
// wire field has to make the tests fail. Run this against the dev stack
// (dev/README.md) whenever the Pyroscope version moves:
//
//   docker compose -f dev/compose.yaml up -d      # wait ~2 minutes for data
//   node e2e/capture.mjs
//
// Writes e2e/fixtures/<Method>[.<variant>].json verbatim, plus meta.json —
// the window and query the capture was taken with. The specs build their
// URLs from meta.json, so the timestamps inside the fixtures always land
// inside the range the page asks for.

import { mkdir, writeFile } from 'node:fs/promises';

const SERVER = process.env.SERVER ?? 'http://localhost:4040';
const TENANT = process.env.TENANT ?? 'team-a';
const OUT = process.env.OUT ?? 'e2e/fixtures';
const SERVICE = process.env.APP ?? 'checkout-service';
const PROFILE_TYPE = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const BASE = '/querier.v1.QuerierService';

// Minute-aligned, because the load generator adds its slowRegression frame
// every other minute: two adjacent minutes are what gives Comparison and
// Diff something real to show.
const MINUTE = 60_000;
const end = Math.floor(Date.now() / MINUTE) * MINUTE;
const window = { start: end - 15 * MINUTE, end };
const right = { start: end - MINUTE, end };
const left = { start: end - 2 * MINUTE, end: end - MINUTE };

const selector = `{service_name="${SERVICE}"}`;
const profile = (range) => ({
  profileTypeID: PROFILE_TYPE,
  labelSelector: selector,
  ...range,
});

async function post(method, body, { tenant = TENANT } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tenant !== undefined) headers['X-Scope-OrgID'] = tenant;
  const res = await fetch(`${SERVER}${BASE}/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Saves a response body exactly as it arrived. */
async function save(name, { status, text }, { expect = 200 } = {}) {
  if (status !== expect) {
    throw new Error(`${name}: HTTP ${status} (wanted ${expect})\n${text}`);
  }
  await writeFile(`${OUT}/${name}.json`, text);
  const size = new TextEncoder().encode(text).length;
  console.log(`${OUT}/${name}.json  ${size} bytes`);
  return JSON.parse(text);
}

/**
 * Waits until the load generator's profiles are queryable. `docker compose up
 * -d` returns before the server is listening, so a connection error here is
 * just another reason to keep waiting.
 */
async function waitForData() {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    let reason = '';
    try {
      const { status, text } = await post('Series', {
        ...window,
        matchers: ['{}'],
        labelNames: ['service_name', '__profile_type__'],
      });
      if (status === 200) {
        const sets = JSON.parse(text).labelsSet ?? [];
        if (sets.some((s) => s.labels?.some((l) => l.value === SERVICE)))
          return;
        reason = `no profiles for ${SERVICE} yet`;
      } else {
        reason = `HTTP ${status}`;
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `gave up waiting for ${SERVICE} after 5 minutes: ${reason}`,
      );
    }
    console.log(`waiting for ${SERVER}: ${reason}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

await mkdir(OUT, { recursive: true });
console.log(`capturing from ${SERVER} as ${TENANT || '(no tenant)'}`);
await waitForData();

await save(
  'Series',
  await post('Series', {
    ...window,
    matchers: ['{}'],
    labelNames: ['service_name', '__profile_type__'],
  }),
);
await save('LabelNames', await post('LabelNames', { ...window, matchers: [] }));
await save(
  'LabelValues',
  await post('LabelValues', { name: 'region', ...window, matchers: [] }),
);
await save(
  'SelectMergeStacktraces',
  await post('SelectMergeStacktraces', profile(window)),
);
await save(
  'SelectSeries',
  await post('SelectSeries', { ...profile(window), step: 15 }),
);
await save(
  'SelectSeries.grouped',
  await post('SelectSeries', {
    ...profile(window),
    step: 15,
    groupBy: ['region'],
  }),
);
await save(
  'Diff',
  await post('Diff', { left: profile(left), right: profile(right) }),
);

// The refusal a multitenant server gives when no tenant is supplied. The
// tenant dialog appears on the strength of this body, so it is captured
// rather than guessed.
const probe = await post(
  'LabelNames',
  { ...window, matchers: [] },
  {
    tenant: '',
  },
);
if (probe.status === 200) {
  throw new Error(
    'the server accepted an empty tenant; capture against the multitenant one',
  );
}
await writeFile(`${OUT}/no-tenant.txt`, probe.text);
console.log(`${OUT}/no-tenant.txt  HTTP ${probe.status}`);

await writeFile(
  `${OUT}/meta.json`,
  `${JSON.stringify(
    {
      capturedFrom: SERVER,
      tenant: TENANT,
      service: SERVICE,
      profileType: PROFILE_TYPE,
      query: `{service_name="${SERVICE}", profile_type="${PROFILE_TYPE}"}`,
      window,
      left,
      right,
      noTenantStatus: probe.status,
    },
    null,
    2,
  )}\n`,
);
console.log(`${OUT}/meta.json`);
