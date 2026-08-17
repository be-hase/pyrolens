import uFuzzy from '@leeoniya/ufuzzy';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchLabelNames, fetchLabelValues } from '@api/client';
import { useDebouncedValue } from './useDebouncedValue';
import {
  escapeValue,
  isInternalLabel,
  isValidLabelName,
  toDisplayLabel,
  toInternalLabel,
} from '../queryLang';

const uf = new uFuzzy();
const MAX_SUGGESTIONS = 50;

export interface SuggestionContext {
  kind: 'name' | 'value';
  /** Label whose values are being completed; '' in name mode. */
  labelName: string;
  /** Text typed so far for the current token (fuzzy needle). */
  prefix: string;
  /** Range of the input to replace when a suggestion is accepted. */
  replaceStart: number;
  replaceEnd: number;
}

// Figures out what the caret is currently editing inside a PromQL-style
// selector: a label name (right after `{` or `,`) or a quoted matcher value
// (after `=`, `!=`, `=~` or `!~`).
export function getSuggestionContext(
  text: string,
  caret: number,
): SuggestionContext | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('{');
  if (open === -1 || before.indexOf('}', open) !== -1) return null;

  const value = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)\s*"([^"]*)$/.exec(
    before,
  );
  if (value) {
    const prefix = value[2];
    const rest = /^[^",}]*/.exec(text.slice(caret))?.[0] ?? '';
    return {
      kind: 'value',
      labelName: value[1],
      prefix,
      replaceStart: caret - prefix.length,
      replaceEnd: caret + rest.length,
    };
  }

  const name = /(?:\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)?$/.exec(before);
  if (!name) return null;
  const prefix = name[1] ?? '';
  const rest = /^[a-zA-Z0-9_]*/.exec(text.slice(caret))?.[0] ?? '';
  return {
    kind: 'name',
    labelName: '',
    prefix,
    replaceStart: caret - prefix.length,
    replaceEnd: caret + rest.length,
  };
}

// Splices a picked suggestion into the query and returns the new text plus
// where the caret should land (inside the quotes for a fresh `label=""`).
export function applySuggestion(
  text: string,
  ctx: SuggestionContext,
  item: string,
): { value: string; caret: number } {
  const head = text.slice(0, ctx.replaceStart);
  const tail = text.slice(ctx.replaceEnd);

  if (ctx.kind === 'name') {
    if (/^\s*(?:=~|!~|!=|=)/.test(tail)) {
      return {
        value: head + item + tail,
        caret: ctx.replaceStart + item.length,
      };
    }
    return {
      value: `${head}${item}=""${tail}`,
      caret: ctx.replaceStart + item.length + 2,
    };
  }

  // Label values can contain quotes and backslashes (Windows paths, k8s
  // annotations); splice them in escaped or the selector silently changes
  // meaning or stops parsing.
  const escaped = escapeValue(item);
  const insert = tail.startsWith('"') ? escaped : `${escaped}"`;
  return {
    value: head + insert + tail,
    caret: ctx.replaceStart + escaped.length + 1,
  };
}

function fuzzyFilter(pool: string[], needle: string): string[] {
  if (!needle) return pool.slice(0, MAX_SUGGESTIONS);
  const idxs = uf.filter(pool, needle);
  if (!idxs || idxs.length === 0) return [];
  if (idxs.length > 500) {
    return idxs.slice(0, MAX_SUGGESTIONS).map((i) => pool[i]);
  }
  const info = uf.info(idxs, pool, needle);
  const order = uf.sort(info, pool, needle);
  return order.slice(0, MAX_SUGGESTIONS).map((i) => pool[info.idx[i]]);
}

// Typeahead state for the query bar: fetches label names / label values on
// demand (debounced, cached per range+tenant) and fuzzy-filters them against
// what the user typed at the caret.
export function useLabelSuggestions({
  text,
  caret,
  start,
  end,
  tenantID,
  enabled,
}: {
  text: string;
  caret: number;
  start: number;
  end: number;
  /** Participates only to retrigger fetches on tenant switches. */
  tenantID?: string;
  enabled: boolean;
}): {
  context: SuggestionContext | null;
  suggestions: string[];
  apply: (item: string) => { value: string; caret: number };
} {
  const context = enabled ? getSuggestionContext(text, caret) : null;

  const [names, setNames] = useState<string[]>([]);
  const [values, setValues] = useState<string[]>([]);

  const debStart = useDebouncedValue(start, 300);
  const debEnd = useDebouncedValue(end, 300);
  const labelName = context?.kind === 'value' ? context.labelName : '';
  const debLabel = useDebouncedValue(labelName, 200);

  // Drop fetched labels when the range/tenant or the completed label changes
  // (render-time adjustment, per
  // https://react.dev/learn/you-might-not-need-an-effect).
  const poolKey = `${debStart}:${debEnd}:${tenantID ?? ''}:${debLabel}`;
  const [prevPoolKey, setPrevPoolKey] = useState(poolKey);
  if (prevPoolKey !== poolKey) {
    setPrevPoolKey(poolKey);
    setNames([]);
    setValues([]);
  }

  // The range/tenant the names pool must belong to right now, kept in a ref
  // so a stale response's `.then` (below) can read it without re-rendering.
  // Written from `useLayoutEffect`, not the ordinary (passive) effect below:
  // a layout effect runs synchronously right after commit, in the same tick
  // — a *passive* effect is scheduled for later, and the whole point of this
  // ref is to beat a same-tick microtask that can run in the gap before a
  // passive effect's cleanup fires.
  const namesKey = `${debStart}:${debEnd}:${tenantID ?? ''}`;
  const namesKeyRef = useRef(namesKey);
  useLayoutEffect(() => {
    namesKeyRef.current = namesKey;
  });

  // Both success paths re-check `aborted` before writing: a response that
  // finished parsing before the abort still lands otherwise, and would stick
  // (the pool reset above has already run, so nothing refetches after it).
  //
  // `aborted` alone is not enough, though: the render that changes the range
  // resets `names` and commits synchronously, but this effect's cleanup
  // (which calls `abort()`) only runs when React later flushes passive
  // effects. A response that finishes parsing in that window — a same-tick
  // microtask beating a scheduled effect flush — sees `aborted === false`
  // and would otherwise land under the new range, and since it makes
  // `names.length` nonzero it also disarms `wantNames`, so nothing refetches
  // until the pool key changes again. Comparing the key this fetch was
  // started for against `namesKeyRef.current` catches that response too, and
  // because `names` is still `[]`, `wantNames` stays true so the effect
  // re-runs for the current range.
  const wantNames = context?.kind === 'name' && names.length === 0;
  useEffect(() => {
    if (!wantNames) return;
    const controller = new AbortController();
    const requestKey = namesKey;
    fetchLabelNames([], debStart, debEnd, controller.signal)
      .then((ns) => {
        if (controller.signal.aborted) return;
        if (namesKeyRef.current !== requestKey) return;
        // The server calls it `__profile_type__`; the query language shows
        // `profile_type`, so it has to be offered under that name.
        // Validated, not just filtered: applySuggestion splices the chosen
        // name into the query text, so a server returning something like
        // `x="1",service_name` would smuggle extra matchers into the
        // selector the user thinks they built.
        setNames(
          ns
            .map(toDisplayLabel)
            .filter((n) => !isInternalLabel(n) && isValidLabelName(n)),
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [wantNames, debStart, debEnd, tenantID, namesKey]);

  // Same commit-vs-passive-cleanup race as the names path above (see that
  // comment for the mechanism): a stale response can land after the pool
  // key has already moved on. Unlike names, this effect always re-fetches
  // on the next key, so a stale landing is normally overwritten — except
  // when the replacement fetch rejects, in which case nothing else would
  // ever overwrite it. `valuesKey` also folds in the label, since a value
  // pool belongs to one label as well as one range/tenant.
  const valuesKey = `${debStart}:${debEnd}:${tenantID ?? ''}:${debLabel}`;
  const valuesKeyRef = useRef(valuesKey);
  useLayoutEffect(() => {
    valuesKeyRef.current = valuesKey;
  });

  useEffect(() => {
    if (!debLabel) return;
    const controller = new AbortController();
    const requestKey = valuesKey;
    // The pseudo-label is queried under its server-side name, or the values
    // of `profile_type` come back empty.
    fetchLabelValues(
      toInternalLabel(debLabel),
      [],
      debStart,
      debEnd,
      controller.signal,
    )
      .then((vs) => {
        if (controller.signal.aborted) return;
        if (valuesKeyRef.current !== requestKey) return;
        setValues(vs);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [debLabel, debStart, debEnd, tenantID, valuesKey]);

  // Memoized: the query bar re-renders on every caret move and every mouse
  // move over the popup, and a fuzzy pass over a high-cardinality value pool
  // is too expensive to repeat when neither the pool nor the needle moved.
  const kind = context?.kind;
  const contextLabel = context?.labelName;
  const prefix = context?.prefix;
  const pool = useMemo(() => {
    if (kind === 'name') return names;
    if (kind === 'value' && contextLabel === debLabel) return values;
    return [];
  }, [kind, contextLabel, debLabel, names, values]);
  const suggestions = useMemo(
    () => (prefix === undefined ? [] : fuzzyFilter(pool, prefix)),
    [pool, prefix],
  );

  return {
    context,
    suggestions,
    apply: (item) =>
      context ? applySuggestion(text, context, item) : { value: text, caret },
  };
}
