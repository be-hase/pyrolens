import { useEffect, useRef, useState } from 'react';

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
// - A fetch that is due but has not started counts as loading, so the gap
//   before the effect runs never renders as an answer.
// - Data from a superseded key is only shown while a newer fetch is still
//   in flight (stale-while-refetching); once that fetch settles — success
//   or failure — data belonging to a key nobody is fetching for anymore is
//   replaced by `initial`. And whenever `active` is false, `initial` is
//   returned outright: an inactive hook has nothing current to show.

export interface Fetched<T> {
  data: T;
  fetching: boolean;
  fetchError: string | null;
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
  // The key a fetch has actually been started for, and whether that fetch is
  // still running. The effect only runs after the commit, so between a deps
  // change and that effect there is a render holding the previous data with
  // nothing in flight; reporting "not loading" there shows a stale or empty
  // result as though it were the answer for the new deps.
  const [started, setStarted] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  // `load` is a fresh closure every render; the fetch effect reads the
  // latest one through a ref so `deps` alone decide when to refetch. The
  // ref is written from an effect (declared first, so it runs first) rather
  // than during render.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const key = JSON.stringify(deps);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function run() {
      setStarted(key);
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
      } finally {
        if (!controller.signal.aborted) setInFlight(false);
      }
    }
    run();

    return () => controller.abort();
  }, [active, key]);

  const fetching = active && (started !== key || inFlight);
  // Superseded data still shows while its successor is in flight (the same
  // condition as `fetching`), so a refetch does not blank the screen; once
  // that settles, a key nobody is fetching for falls back to `initial`
  // rather than sitting next to another key's result or error. Inactive
  // always shows `initial` — there is nothing current to show.
  const showStored = active && (dataKey === key || fetching);

  return {
    data: showStored ? data : stableInitial,
    fetching,
    fetchError,
  };
}
