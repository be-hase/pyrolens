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
  maxNodes,
}: FetchOpts & {
  // Kept off the shared FetchOpts on purpose: useTimeline takes the same
  // interface, and SelectSeries (the RPC behind it) has no maxNodes field —
  // sharing the property there would type-check and silently do nothing.
  /** Caps the node count per flamegraph query; server default when unset. */
  maxNodes?: number;
}): {
  flamegraph: FlamegraphData;
  loading: boolean;
  error: string | null;
  retry?: () => void;
} {
  const { profileTypeID, labelSelector } = splitQuery(query);
  const { start, end } = range;

  // Derived, not stored: when there is nothing to fetch the spinner and any
  // previous error disappear without an effect having to reset them (an
  // aborted request never reaches its own cleanup).
  const active = enabled && !!profileTypeID;
  const { data, fetching, fetchError, retry } = useFetched(
    EMPTY,
    active,
    (signal) =>
      fetchFlamegraph(
        { profileTypeID, labelSelector, start, end },
        maxNodes,
        signal,
      ),
    // maxNodes must be in this list, same as every other value `load` reads:
    // otherwise changing it (a deep-linked maxNodes edited in place) would
    // leave the flamegraph pinned to whatever the first fetch used.
    [profileTypeID, labelSelector, start, end, tenantID, maxNodes],
  );

  const malformed = malformedMessage(query);
  return {
    flamegraph: data,
    loading: active && fetching,
    error: malformed ?? (active ? fetchError : null),
    // A malformed query (or a broken profile_type) never made `active`
    // true, so no fetch ever started for it — retry() would just bump a
    // counter into an effect that early-returns on `!active`. Exposing it
    // anyway rendered a Retry button that looked live but did nothing.
    retry: malformed ? undefined : retry,
  };
}

export function useTimeline({
  query,
  range,
  tenantID,
  enabled = true,
}: FetchOpts): {
  timeline: Point[];
  loading: boolean;
  error: string | null;
  retry?: () => void;
} {
  const { profileTypeID, labelSelector } = splitQuery(query);
  const { start, end } = range;

  const active = enabled && !!profileTypeID;
  const { data, fetching, fetchError, retry } = useFetched(
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

  const malformed = malformedMessage(query);
  return {
    timeline: data,
    loading: active && fetching,
    error: malformed ?? (active ? fetchError : null),
    // See useFlamegraph: a malformed query never started a fetch, so retry
    // must not be offered for it.
    retry: malformed ? undefined : retry,
  };
}

export function useDiffFlamegraph({
  leftQuery,
  rightQuery,
  leftRange,
  rightRange,
  tenantID,
  maxNodes,
}: {
  leftQuery: string;
  rightQuery: string;
  leftRange: TimeRange;
  rightRange: TimeRange;
  tenantID?: string;
  // This hook has its own opts type rather than FetchOpts (it takes two
  // queries and two ranges), so maxNodes living here needs no exclusion —
  // see useFlamegraph's comment for why it's kept off the shared interface.
  /** Caps the node count per side; server default when unset. */
  maxNodes?: number;
}): {
  diff: DiffFlamegraphData | null;
  loading: boolean;
  error: string | null;
  retry?: () => void;
} {
  const left = splitQuery(leftQuery);
  const right = splitQuery(rightQuery);

  // The upstream Diff RPC assumes both sides sample the same profile type
  // (e.g. both cpu, or both alloc) and returns a differential flame graph
  // built as if that were true even when it isn't — a mismatched pair must
  // never reach fetchDiffFlamegraph at all, not just be flagged after the
  // fact. DiffView renders a contextual message for this case instead.
  const active =
    !!left.profileTypeID &&
    !!right.profileTypeID &&
    left.profileTypeID === right.profileTypeID;
  const { data, fetching, fetchError, retry } =
    useFetched<DiffFlamegraphData | null>(
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
          maxNodes,
          signal,
        ),
      // maxNodes must be in this list — see useFlamegraph's identical note.
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
        maxNodes,
      ],
    );

  // First non-null wins: whichever pane is broken, the message names the
  // real problem instead of always blaming the left pane.
  const malformed = malformedMessage(leftQuery) ?? malformedMessage(rightQuery);
  return {
    diff: data,
    loading: active && fetching,
    error: malformed ?? (active ? fetchError : null),
    // See useFlamegraph: either pane being malformed means no fetch ever
    // started, so retry must not be offered.
    retry: malformed ? undefined : retry,
  };
}
