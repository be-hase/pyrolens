import {
  fetchDiffFlamegraph,
  fetchFlamegraph,
  fetchTimeline,
  type DiffFlamegraphData,
  type FlamegraphData,
  type Point,
} from '@api/client';
import { malformedQueryReason, splitQuery } from '../queryLang';
import { timelineStep, type TimeRange } from '../time';
import { useFetched } from './useFetched';

const EMPTY: FlamegraphData = { names: [], levels: [] };

export const MALFORMED_MESSAGE =
  'Could not parse the query. Expected a selector like ' +
  '{service_name="my-service", profile_type="..."}.';

export const PROFILE_TYPE_MESSAGE =
  'profile_type needs exactly one "=" matcher with a non-empty value. ' +
  'Remove the conflicting, empty, or regex/negated profile_type matchers ' +
  'and keep a single profile_type="...".';

/**
 * Maps a query to the message a hook should show for it, or null when the
 * query is usable (blank or parses with a supported pseudo-label). Kept as
 * one function so `useFlamegraph`, `useTimeline` and `useDiffFlamegraph`
 * cannot pick different wording for the same {@link malformedQueryReason}.
 */
export function malformedMessage(query: string): string | null {
  switch (malformedQueryReason(query)) {
    case 'syntax':
      return MALFORMED_MESSAGE;
    case 'profileType':
      return PROFILE_TYPE_MESSAGE;
    case null:
      return null;
  }
}

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
    error: malformedMessage(query) ?? (active ? fetchError : null),
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
    error: malformedMessage(query) ?? (active ? fetchError : null),
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
    // First non-null wins: whichever pane is broken, the message names the
    // real problem instead of always blaming the left pane.
    error:
      malformedMessage(leftQuery) ??
      malformedMessage(rightQuery) ??
      (active ? fetchError : null),
  };
}
