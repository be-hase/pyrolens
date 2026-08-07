import { useEffect, useState } from 'react';
import {
  fetchFlamegraph,
  fetchTimeline,
  type FlamegraphData,
  type Point,
} from '@api/client';
import { isMalformedQuery, splitQuery } from '../queryLang';
import { timelineStep, type TimeRange } from '../time';

const EMPTY: FlamegraphData = { names: [], levels: [] };

const MALFORMED_MESSAGE =
  'Could not parse the query. Expected a selector like ' +
  '{service_name="my-service", profile_type="..."}.';

interface FetchOpts {
  query: string;
  range: TimeRange;
  /** Participates only to retrigger fetches on tenant switches. */
  tenantID?: string;
  enabled?: boolean;
}

export function useFlamegraph({
  query,
  range,
  tenantID,
  enabled = true,
}: FetchOpts): {
  flamegraph: FlamegraphData;
  loading: boolean;
  error: string | null;
} {
  const [flamegraph, setFlamegraph] = useState<FlamegraphData>(EMPTY);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const { profileTypeID, labelSelector } = splitQuery(query);
  const malformed = isMalformedQuery(query);
  const { start, end } = range;

  // Derived, not stored: when there is nothing to fetch the spinner and any
  // previous error disappear without an effect having to reset them (an
  // aborted request never reaches its own cleanup).
  const active = enabled && !!profileTypeID;
  const loading = active && fetching;
  const error = malformed ? MALFORMED_MESSAGE : active ? fetchError : null;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function load() {
      setFetching(true);
      setFetchError(null);
      try {
        const fg = await fetchFlamegraph(
          { profileTypeID, labelSelector, start, end },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setFlamegraph(fg);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setFetching(false);
      }
    }
    load();

    return () => controller.abort();
  }, [active, profileTypeID, labelSelector, start, end, tenantID]);

  return { flamegraph, loading, error };
}

export function useTimeline({
  query,
  range,
  tenantID,
  enabled = true,
}: FetchOpts): { timeline: Point[]; loading: boolean; error: string | null } {
  const [timeline, setTimeline] = useState<Point[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const { profileTypeID, labelSelector } = splitQuery(query);
  const malformed = isMalformedQuery(query);
  const { start, end } = range;

  // Derived, not stored: when there is nothing to fetch the spinner and any
  // previous error disappear without an effect having to reset them (an
  // aborted request never reaches its own cleanup).
  const active = enabled && !!profileTypeID;
  const loading = active && fetching;
  const error = malformed ? MALFORMED_MESSAGE : active ? fetchError : null;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function load() {
      setFetching(true);
      setFetchError(null);
      try {
        const tl = await fetchTimeline(
          {
            profileTypeID,
            labelSelector,
            start,
            end,
            step: timelineStep({ start, end }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTimeline(tl);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setFetching(false);
      }
    }
    load();

    return () => controller.abort();
  }, [active, profileTypeID, labelSelector, start, end, tenantID]);

  return { timeline, loading, error };
}
