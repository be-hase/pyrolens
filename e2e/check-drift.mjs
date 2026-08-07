// Compares a fresh capture against the committed fixtures and fails when the
// server's responses no longer have the shape the suite was recorded against.
//
//   OUT=/tmp/fresh node e2e/capture.mjs
//   FRESH=/tmp/fresh node e2e/check-drift.mjs
//
// Why this exists: the e2e suite replays fixtures, so it keeps passing however
// far the real Pyroscope moves away from them — and the version in
// dev/compose.yaml is bumped automatically. Nothing else would notice.
//
// Values are expected to differ on every capture, so this compares structure:
// which keys exist and what type each holds. A renamed or dropped field shows
// up; a different number of samples does not.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const withSlash = (path) => (path.endsWith('/') ? path : `${path}/`);
const COMMITTED = withSlash(
  process.env.COMMITTED ?? fileURLToPath(new URL('fixtures/', import.meta.url)),
);
const FRESH = withSlash(process.env.FRESH ?? '/tmp/pyrolens-fresh-fixtures');

/** A recursive description of a value's structure, ignoring the values. */
function shape(value) {
  if (Array.isArray(value)) {
    // Arrays are homogeneous here; an empty one tells us nothing, which is
    // itself worth reporting.
    return value.length === 0 ? '[]' : `[${shape(value[0])}]`;
  }
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}:${shape(value[key])}`)
    .join(',')}}`;
}

const read = (dir, name) => JSON.parse(readFileSync(`${dir}${name}`, 'utf8'));

const problems = [];
const note = (message) => problems.push(message);

const fixtures = readdirSync(COMMITTED)
  .filter((f) => f.endsWith('.json') && f !== 'meta.json')
  .sort();

for (const name of fixtures) {
  let fresh;
  try {
    fresh = read(FRESH, name);
  } catch {
    note(`${name}: the capture produced nothing`);
    continue;
  }
  const before = shape(read(COMMITTED, name));
  const after = shape(fresh);
  if (before !== after) {
    note(`${name}: shape changed\n    was: ${before}\n    now: ${after}`);
  }
  if (after.includes('[]')) {
    note(`${name}: captured an empty list — the server had no data to give`);
  }
}

// The tenancy probe reads this body with /org|tenant/i; a reworded refusal
// would leave the UI thinking every server is single-tenant.
let refusal = '';
try {
  refusal = readFileSync(`${FRESH}no-tenant.txt`, 'utf8');
} catch {
  note('no-tenant.txt: the capture produced nothing');
}
if (refusal && !/org|tenant/i.test(refusal)) {
  note(
    `no-tenant.txt: the refusal no longer mentions an org or a tenant, so the\n` +
      `    multitenancy probe would misread it: ${refusal.trim()}`,
  );
}

const meta = read(COMMITTED, 'meta.json');
const freshMeta = read(FRESH, 'meta.json');
if (meta.noTenantStatus !== freshMeta.noTenantStatus) {
  note(
    `no-tenant status changed: ${meta.noTenantStatus} -> ${freshMeta.noTenantStatus}`,
  );
}

if (problems.length === 0) {
  console.log(`${fixtures.length} fixtures still match what the server sends`);
  process.exit(0);
}

console.error('The captured fixtures no longer match the server:\n');
for (const problem of problems) console.error(`  - ${problem}`);
console.error(
  `\nRe-record them and review the diff (e2e/README.md):\n` +
    `  docker compose -f dev/compose.yaml up -d\n` +
    `  node e2e/capture.mjs\n`,
);
process.exit(1);
