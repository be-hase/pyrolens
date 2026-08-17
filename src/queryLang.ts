// PromQL-style label-selector query language.
//
// The UI works with a single "display query" string such as
//   {service_name="checkout", profile_type="process_cpu:cpu:nanoseconds:cpu:nanoseconds", region=~"us-.*"}
// where `profile_type` is a pseudo-label: it is shown to the user inside the
// selector, but the Pyroscope querier API wants it split out as a dedicated
// `profileTypeID` argument next to a plain `labelSelector`.

import { sortProfileTypes, type Service } from '@api/client';

type MatcherOp = '=' | '!=' | '=~' | '!~';

interface Matcher {
  label: string;
  op: MatcherOp;
  value: string;
}

const PROFILE_TYPE = 'profile_type';
const PROFILE_TYPE_INTERNAL = '__profile_type__';
const SERVICE_NAME = 'service_name';

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const FULL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** True when `name` is a syntactically valid label name. */
export function isValidLabelName(name: string): boolean {
  return FULL_NAME_RE.test(name);
}

function isProfileTypeLabel(label: string): boolean {
  return label === PROFILE_TYPE || label === PROFILE_TYPE_INTERNAL;
}

/**
 * The single, shared read of the pseudo-label across a matcher list.
 * `profile_type` and `__profile_type__` name the same underlying constraint,
 * so the querier can honour only one value between them, and only through
 * `=` — every other reader (`isMalformedQuery` / `malformedQueryReason`,
 * `splitQuery`, `parseQuery`) computes this once and agrees by construction,
 * rather than each re-deriving its own notion of "which value" and drifting
 * apart the way `splitQuery` and `isMalformedQuery` once did.
 *
 * `unsupported` is true when the API cannot express what was asked: any
 * pseudo-label matcher used an operator other than `=` (the querier takes a
 * single profileTypeID, so `=~`/`!=`/`!~` can be neither sent nor honoured),
 * two or more distinct `=` values were given (PromQL for "matches nothing" —
 * sending either would misreport that as a real answer), or an `=` value was
 * the empty string (the querier's profileTypeID can never be empty, so
 * `profile_type=""` asks for something the API has no way to send — the same
 * class of problem as `=~`). `value` is the one distinct `=` value when there
 * is exactly one and nothing is unsupported, else null. A matcher list with
 * no pseudo-label at all is unaffected: `unsupported` is false and `value` is
 * null, the "nothing selected yet" state callers rely on.
 */
function assessProfileType(matchers: Matcher[]): {
  unsupported: boolean;
  value: string | null;
} {
  const values = new Set<string>();
  let hasNonEquality = false;
  for (const m of matchers) {
    if (!isProfileTypeLabel(m.label)) continue;
    if (m.op === '=') values.add(m.value);
    else hasNonEquality = true;
  }
  const unsupported = hasNonEquality || values.size > 1 || values.has('');
  const value = !unsupported && values.size === 1 ? [...values][0] : null;
  return { unsupported, value };
}

// Parses `{name op "value", ...}` into matchers. Returns null when the input
// is not a valid selector; an empty/blank string or `{}` parses to [].
// Whitespace is tolerated everywhere between tokens. Values support the
// escapes \" \\ \n \t; an unknown escape keeps its backslash verbatim.
function parseMatchers(query: string): Matcher[] | null {
  const s = query.trim();
  if (s === '') return [];
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const inner = s.slice(1, -1);

  const matchers: Matcher[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < inner.length && /\s/.test(inner[i])) i++;
  };

  skipWs();
  while (i < inner.length) {
    const name = NAME_RE.exec(inner.slice(i));
    if (!name) return null;
    const label = name[0];
    i += label.length;
    skipWs();

    let op: MatcherOp;
    if (inner.startsWith('=~', i)) {
      op = '=~';
      i += 2;
    } else if (inner.startsWith('!=', i)) {
      op = '!=';
      i += 2;
    } else if (inner.startsWith('!~', i)) {
      op = '!~';
      i += 2;
    } else if (inner[i] === '=') {
      op = '=';
      i += 1;
    } else {
      return null;
    }
    skipWs();

    if (inner[i] !== '"') return null;
    i++;
    let value = '';
    let closed = false;
    while (i < inner.length) {
      const c = inner[i];
      if (c === '"') {
        closed = true;
        i++;
        break;
      }
      if (c === '\\') {
        i++;
        if (i >= inner.length) return null;
        const e = inner[i];
        if (e === 'n') value += '\n';
        else if (e === 't') value += '\t';
        else if (e === '"' || e === '\\') value += e;
        else value += '\\' + e;
        i++;
      } else {
        value += c;
        i++;
      }
    }
    if (!closed) return null;

    matchers.push({ label, op, value });
    skipWs();
    if (i < inner.length) {
      if (inner[i] !== ',') return null;
      i++;
      skipWs(); // a trailing comma before `}` is tolerated
    }
  }
  return matchers;
}

/**
 * Escapes a value for use *inside* an already-quoted matcher, e.g. when a
 * typeahead suggestion is spliced between existing quotes.
 */
export function escapeValue(value: string): string {
  let out = '';
  for (const c of value) {
    if (c === '\\' || c === '"') out += '\\' + c;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return out;
}

function quote(value: string): string {
  return '"' + escapeValue(value) + '"';
}

function formatMatchers(matchers: Matcher[]): string {
  const body = matchers
    .map((m) => `${m.label}${m.op}${quote(m.value)}`)
    .join(', ');
  return `{${body}}`;
}

/**
 * Why a query can't be used, or null when it can. 'syntax' covers input that
 * does not parse at all; 'profileType' covers input that parses fine but
 * asks something the API cannot express of the pseudo-label — see
 * {@link assessProfileType}. Distinguishing the two lets a caller point the
 * user at the actual problem instead of blaming syntax for a query that
 * parsed.
 */
export function malformedQueryReason(
  query: string,
): 'syntax' | 'profileType' | null {
  if (query.trim() === '') return null;
  const matchers = parseMatchers(query);
  if (matchers === null) return 'syntax';
  return assessProfileType(matchers).unsupported ? 'profileType' : null;
}

/**
 * True when the query is non-empty but cannot be used as typed, i.e. the
 * user typed something malformed rather than leaving the field blank. See
 * {@link malformedQueryReason} for why.
 */
export function isMalformedQuery(query: string): boolean {
  return malformedQueryReason(query) !== null;
}

/**
 * Splits a display query into what the querier API expects. The
 * `profile_type` (or `__profile_type__`) pseudo-matcher supplies
 * `profileTypeID` and is removed from the returned `labelSelector`, which is
 * re-serialized in normalized form (`{}` when nothing remains). Unparseable
 * input, and input where the pseudo-label is unsupported (see
 * {@link assessProfileType} — a non-`=` operator anywhere on it, or two or
 * more distinct `=` values), yields `{ profileTypeID: '', labelSelector:
 * '{}' }` — callers gate API calls on a truthy profileTypeID, so an
 * unsupported constraint is never silently dropped from the request.
 */
export function splitQuery(query: string): {
  profileTypeID: string;
  labelSelector: string;
} {
  const matchers = parseMatchers(query);
  if (!matchers) return { profileTypeID: '', labelSelector: '{}' };

  const { value } = assessProfileType(matchers);
  const rest = matchers.filter((m) => !isProfileTypeLabel(m.label));
  return { profileTypeID: value ?? '', labelSelector: formatMatchers(rest) };
}

/**
 * Extracts the service / profile-type pair driving the cascade picker.
 * Returns null unless the query parses, `service_name` has at least one `=`
 * matcher (last one wins, like any ordinary label), and the pseudo-label is
 * supported with exactly one distinct `=` value (see
 * {@link assessProfileType} — a non-`=` operator or conflicting values
 * return null here too, so the picker never shows a value the query didn't
 * unambiguously ask for).
 */
export function parseQuery(
  query: string,
): { service: string; profileType: string } | null {
  const matchers = parseMatchers(query);
  if (!matchers) return null;

  let service: string | null = null;
  for (const m of matchers) {
    if (m.op === '=' && m.label === SERVICE_NAME) service = m.value;
  }
  const { value: profileType } = assessProfileType(matchers);
  if (service === null || profileType === null) return null;
  return { service, profileType };
}

/** Builds a fresh display query for a service / profile-type selection. */
export function buildQuery(service: string, profileTypeID: string): string {
  return formatMatchers([
    { label: SERVICE_NAME, op: '=', value: service },
    { label: PROFILE_TYPE, op: '=', value: profileTypeID },
  ]);
}

/**
 * Whether App's default-query effect (App.tsx) is about to write a `query`
 * param: the URL has none yet (`rawQuery === null` — an explicit `''` from a
 * cleared query bar is a real answer, not a gap) and a service list has
 * arrived with a usable profile type on its first entry, the same pair
 * `buildQuery` would be called with.
 *
 * Shared by App's effect and every view's startup-gap flag so the two agree
 * by construction — the same reasoning as {@link assessProfileType}'s three
 * readers. A view re-deriving its own notion of "is a write coming" could
 * drift from the effect's actual condition and paint a false conclusion (or
 * a permanent spinner) in the one render between them disagreeing.
 */
export function defaultQueryPending(
  services: Service[],
  rawQuery: string | null,
): boolean {
  if (rawQuery !== null || services.length === 0) return false;
  const first = services[0];
  return !!sortProfileTypes(first.profileTypes)[0];
}

/** True for reserved dunder labels such as `__session_id__`. */
export function isInternalLabel(name: string): boolean {
  return /^__.+__$/.test(name);
}

/** Maps internal label names to their display form (`__profile_type__` → `profile_type`). */
export function toDisplayLabel(name: string): string {
  return name === PROFILE_TYPE_INTERNAL ? PROFILE_TYPE : name;
}

/** Inverse of {@link toDisplayLabel} (`profile_type` → `__profile_type__`). */
export function toInternalLabel(name: string): string {
  return name === PROFILE_TYPE ? PROFILE_TYPE_INTERNAL : name;
}

/**
 * Returns `query` with an `label="value"` equality matcher upserted: an
 * existing matcher for the label (any operator) is replaced in place,
 * duplicates are dropped, otherwise the matcher is appended. The result is
 * re-serialized in normalized form.
 */
export function upsertMatcher(
  query: string,
  label: string,
  value: string,
): string {
  // A label arriving from a URL param or from server data could otherwise
  // inject extra matchers into the selector.
  if (!isValidLabelName(label)) return query;
  const matchers = parseMatchers(query);
  // An unparseable query is left alone, like a bad label above: rebuilding
  // from nothing would silently discard every matcher the user had.
  if (matchers === null) return query;
  const next: Matcher[] = [];
  let replaced = false;
  for (const m of matchers) {
    if (m.label === label) {
      if (!replaced) {
        next.push({ label, op: '=', value });
        replaced = true;
      }
    } else {
      next.push(m);
    }
  }
  if (!replaced) next.push({ label, op: '=', value });
  return formatMatchers(next);
}
