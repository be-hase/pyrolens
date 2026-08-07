import uFuzzy from '@leeoniya/ufuzzy';
import { useEffect, useState } from 'react';
import { fetchLabelNames, fetchLabelValues } from '@api/client';
import { useDebouncedValue } from './useDebouncedValue';
import { escapeValue, isInternalLabel } from '../queryLang';

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

  const wantNames = context?.kind === 'name' && names.length === 0;
  useEffect(() => {
    if (!wantNames) return;
    const controller = new AbortController();
    fetchLabelNames([], debStart, debEnd, controller.signal)
      .then((ns) => setNames(ns.filter((n) => !isInternalLabel(n))))
      .catch(() => {});
    return () => controller.abort();
  }, [wantNames, debStart, debEnd, tenantID]);

  useEffect(() => {
    if (!debLabel) return;
    const controller = new AbortController();
    fetchLabelValues(debLabel, [], debStart, debEnd, controller.signal)
      .then((vs) => setValues(vs))
      .catch(() => {});
    return () => controller.abort();
  }, [debLabel, debStart, debEnd, tenantID]);

  let pool: string[] = [];
  if (context?.kind === 'name') {
    pool = names;
  } else if (context && context.labelName === debLabel) {
    pool = values;
  }
  const suggestions = context ? fuzzyFilter(pool, context.prefix) : [];

  return {
    context,
    suggestions,
    apply: (item) =>
      context ? applySuggestion(text, context, item) : { value: text, caret },
  };
}
