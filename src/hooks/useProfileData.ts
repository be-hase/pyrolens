import {
  fetchDiffFlamegraph,
  fetchFlamegraph,
  fetchTimeline,
  type DiffFlamegraphData,
  type FlamegraphData,
  type Point,
} from '@api/client';
import { isMalformedQuery, splitQuery } from '../queryLang';
import { timelineStep, type TimeRange } from '../time';
import { useFetched } from './useFetched';

const EMPTY: FlamegraphData = { names: [], levels: [] };

export const MALFORMED_MESSAGE =
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
  const { profileTypeID, labelSelector } = splitQuery(query);
  const { start, end } = range;

  // Derived, not stored: when there is nothing to fetch the spinner and any
  // previous error disappear without an effect having to reset them (an
  // aborted request never reaches its own cleanup).
  const active = enabled && !!profileTypeID;
  const { data, fetching, fetchError } = useFetched(
    EMPTY,
    active,
    (signal) =>
      fetchFlamegraph({ profileTypeID, labelSelector, start, end }, signal),
    [profileTypeID, labelSelector, start, end, tenantID],
  );

  return {
    flamegraph: data,
    loading: active && fetching,
    error: isMalformedQuery(query)
      ? MALFORMED_MESSAGE
      : active
        ? fetchError
        : null,
  };
}

export function useTimeline({
  query,
  range,
  tenantID,
  enabled = true,
}: FetchOpts): { timeline: Point[]; loading: boolean; error: string | null } {
  const { profileTypeID, labelSelector } = splitQuery(query);
  const { start, end } = range;

  const active = enabled && !!profileTypeID;
  const { data, fetching, fetchError } = useFetched(
    [] as Point[],
    active,
    (signal) =>
      fetchTimeline(
        {
          profileTypeID,
          labelSelector,
          start,
          end,
          step: timelineStep({ start, end }),
        },
        signal,
      ),
    [profileTypeID, labelSelector, start, end, tenantID],
  );

  return {
    timeline: data,
    loading: active && fetching,
    error: isMalformedQuery(query)
      ? MALFORMED_MESSAGE
      : active
        ? fetchError
        : null,
  };
}

export function useDiffFlamegraph({
  leftQuery,
  rightQuery,
  leftRange,
  rightRange,
  tenantID,
}: {
  leftQuery: string;
  rightQuery: string;
  leftRange: TimeRange;
  rightRange: TimeRange;
  tenantID?: string;
}): {
  diff: DiffFlamegraphData | null;
  loading: boolean;
  error: string | null;
} {
  const left = splitQuery(leftQuery);
  const right = splitQuery(rightQuery);

  const active = !!left.profileTypeID && !!right.profileTypeID;
  const { data, fetching, fetchError } = useFetched<DiffFlamegraphData | null>(
    null,
    active,
    (signal) =>
      fetchDiffFlamegraph(
        {
          profileTypeID: left.profileTypeID,
          labelSelector: left.labelSelector,
          start: leftRange.start,
          end: leftRange.end,
        },
        {
          profileTypeID: right.profileTypeID,
          labelSelector: right.labelSelector,
          start: rightRange.start,
          end: rightRange.end,
        },
        signal,
      ),
    [
      left.profileTypeID,
      left.labelSelector,
      right.profileTypeID,
      right.labelSelector,
      leftRange.start,
      leftRange.end,
      rightRange.start,
      rightRange.end,
      tenantID,
    ],
  );

  return {
    diff: data,
    loading: active && fetching,
    error:
      isMalformedQuery(leftQuery) || isMalformedQuery(rightQuery)
        ? MALFORMED_MESSAGE
        : active
          ? fetchError
          : null,
  };
}
