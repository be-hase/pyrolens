import { useCallback, useEffect, useRef, useState } from 'react';

// The one fetch-effect skeleton every data hook shares. The protocol it
// enforces used to be copy-pasted per call site, and the copies drifted —
// one never cleared a stale error, another never aborted at all — so the
// rules live here once:
//
// - `fetching` and `fetchError` are meant to be *derived from* by callers
//   (`loading = active && fetching`), never reset from an effect body.
// - Every path after the await re-checks `signal.aborted` before touching
//   state — success included, or rapid navigation writes a superseded
//   response over the current one.
// - The previous error is cleared when a new fetch starts, so a fixed
//   query does not keep showing the failure of the one before it.
// - `fetchError` is scoped to the key it happened for (`errorKey`), the same
//   way `data` is scoped by `dataKey`. It is set inside `run()`, a passive
//   effect that fires after paint, so the render between a deps change and
//   that effect landing would otherwise still be holding the previous key's
//   error — reporting `fetching: true` while also painting a stale failure
//   in place of the spinner, wrongly attributed to the new key.
// - A fetch that is due but has not started counts as loading, so the gap
//   before the effect runs never renders as an answer.
// - Data from a superseded key is only shown while a newer fetch is still
//   in flight (stale-while-refetching); once that fetch settles — success
//   or failure — data belonging to a key nobody is fetching for anymore is
//   replaced by `initial`. And whenever `active` is false, `initial` is
//   returned outright: an inactive hook has nothing current to show.
// - `retry()` re-runs the load for the *current* deps key without changing
//   what counts as that key's data: it bumps an `attempt` counter that only
//   participates in the run identity (so the due-but-not-started gap still
//   counts as loading after a retry), never in `dataKey` (so a retry keeps
//   showing that key's previous data while it reloads — the same
//   stale-while-refetching behaviour a deps change gets).
// - `settled` is true once any run — success or failure, for any key — has
//   completed since mount, and never goes back to false. It is derived from
//   `dataKey`/`errorKey`: both start `null` and are only ever assigned
//   forward (a completed run's key), never cleared, so "either is non-null"
//   already means "at least one run has finished" with no extra state and
//   nothing to reset. A caller gating a startup placeholder ("has the first
//   answer arrived yet") must read this, not `fetching` — `fetching` pulses
//   true again on every background refetch (a deps change, an auto-refresh
//   tick), and a gate built on it would flip an already-settled, honestly
//   empty conclusion back into a spinner on every one of those pulses
//   instead of only before the first answer ever arrives.

export interface Fetched<T> {
  data: T;
  fetching: boolean;
  fetchError: string | null;
  retry: () => void;
  settled: boolean;
}

/**
 * Runs `load` whenever `active` is true and `deps` change, keeping the last
 * `data` across refetches. `deps` must contain every value `load` reads.
 *
 * Deps are compared by their JSON form, so pass only strings, finite numbers
 * and booleans — inside an array `undefined` and `null` both serialize to
 * `null`, and a dep flipping between the two would not refetch.
 */
export function useFetched<T>(
  initial: T,
  active: boolean,
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly (string | number | boolean | null | undefined)[],
): Fetched<T> {
  // Captured once: React keeps a `useState` argument only from the render
  // that mounted it. Callers pass a fresh `[]` literal as `initial` on every
  // render, and returning a new reference each time it applies would churn
  // any `useMemo` downstream that depends on `data`. (A ref would do the
  // same job, but reading `.current` during render breaks the rules of
  // React, which the lint config enforces.)
  const [stableInitial] = useState(initial);
  const [data, setData] = useState<T>(initial);
  // The key `data` was actually produced for, so a key that no one is
  // fetching for anymore (superseded, and that fetch has since settled)
  // does not keep painting its stale answer next to a different key's
  // result or error.
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // The key `fetchError` was actually produced for — mirrors `dataKey` so a
  // superseded key's failure does not paint against the key that replaced
  // it during the gap before the next run's effect clears it.
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // The run a fetch has actually been started for (key plus attempt — see
  // `runId` below), and whether that fetch is still running. The effect only
  // runs after the commit, so between a deps/attempt change and that effect
  // there is a render holding the previous data with nothing in flight;
  // reporting "not loading" there shows a stale or empty result as though it
  // were the answer for the new run.
  const [started, setStarted] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  // Bumped by `retry()` to force the effect below to re-run for the same
  // deps key. Only ever compared as part of `runId` — it never touches
  // `dataKey`, so a retry is stale-while-refetching against that key's own
  // previous data, exactly like a deps change is against the key before it.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  // `load` is a fresh closure every render; the fetch effect reads the
  // latest one through a ref so `deps` alone decide when to refetch. The
  // ref is written from an effect (declared first, so it runs first) rather
  // than during render.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const key = JSON.stringify(deps);
  // Identifies a single run of the effect below. Comparing `started` against
  // this (rather than against `key` alone) is what makes a retry of the same
  // key immediately read as "started !== runId" — the loading gap between
  // the attempt bump and the effect running would otherwise report idle,
  // because `key` itself never changed.
  const runId = `${key}#${attempt}`;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function run() {
      setStarted(runId);
      setInFlight(true);
      setFetchError(null);
      try {
        const value = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setDataKey(key);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setFetchError(e instanceof Error ? e.message : String(e));
        setErrorKey(key);
      } finally {
        if (!controller.signal.aborted) setInFlight(false);
      }
    }
    run();

    return () => controller.abort();
  }, [active, key, attempt, runId]);

  const fetching = active && (started !== runId || inFlight);
  // Superseded data still shows while its successor is in flight (the same
  // condition as `fetching`), so a refetch does not blank the screen; once
  // that settles, a key nobody is fetching for falls back to `initial`
  // rather than sitting next to another key's result or error. Inactive
  // always shows `initial` — there is nothing current to show.
  const showStored = active && (dataKey === key || fetching);

  return {
    data: showStored ? data : stableInitial,
    fetching,
    // Suppress a superseded key's failure during the gap before its
    // successor's effect has run (and cleared it) — see the header comment.
    fetchError: errorKey === key ? fetchError : null,
    retry,
    // See the header comment: monotonic, derived from dataKey/errorKey only
    // ever moving from null to a real key.
    settled: dataKey !== null || errorKey !== null,
  };
}
