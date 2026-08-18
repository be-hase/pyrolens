import { Button } from '@components/core/Button';
import { Panel } from '@components/Panel';
import { QueryBar } from '@components/QueryBar';
import { TimeSeries } from '@components/TimeSeries';
import { useTimeline } from '@hooks/useProfileData';
import { useEditBuffer } from '@hooks/useEditBuffer';
import { splitQuery } from '../queryLang';
import { formatPaneWindow, type TimeRange } from '../time';
import { navigate, useTickNavigation } from '../urlState';
import type { PaneParams } from './comparisonParams';

// Error banner shared by every view: the message plus, when the hook that
// produced it exposes one, a Retry button that re-runs just that fetch.
// `role="alert"` matters here because these mount conditionally — that is
// what makes role=alert announce the transition to assistive tech, an
// error banner present since first paint would not.
export function ErrorBanner({
  error,
  retry,
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <div
      className="app-error"
      role="alert"
      style={
        retry
          ? {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
            }
          : undefined
      }
    >
      <span>{error}</span>
      {retry && (
        <Button icon="refresh" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// One side of the Comparison/Diff views: a query bar plus a brushable
// timeline spanning the main range, with the pane's own sub-range
// highlighted. Writes to `<side>Query` / `<side>From` / `<side>Until`.
export function ComparisonPane({
  title,
  pane,
  mainRange,
  mainFrom,
  tenantID,
  queryStartupGap,
  children,
}: {
  title: string;
  pane: PaneParams;
  mainRange: TimeRange;
  mainFrom: string;
  tenantID?: string;
  /**
   * Whether the main query hasn't resolved to something real yet — either
   * the top-level services fetch (ViewProps.servicesSettled) has never
   * settled, or it has and App's default-query write is due but hasn't
   * landed in the URL yet (queryLang.ts's `defaultQueryPending`). Before
   * that, an inheriting pane's `profileTypeID` is empty because there is no
   * query yet — not because nothing matched. See `settlingQuery` below.
   * Renamed from `servicesLoading`: that flag pulsed true on every
   * auto-refresh tick (see useServices), which flipped an already-settled,
   * honestly empty pane back into a spinner on every tick — the caller now
   * computes this once from `settled` state instead.
   */
  queryStartupGap?: boolean;
  children?: React.ReactNode;
}) {
  const { timeline, loading, error, retry } = useTimeline({
    query: pane.query,
    range: mainRange,
    tenantID,
  });
  const { profileTypeID } = splitQuery(pane.query);
  const settlingQuery = !!queryStartupGap && !profileTypeID;
  // An auto-refresh tick must not visually interrupt (urlState.ts's
  // useTickNavigation doctrine) — suppresses the chart's reload-dim for a
  // tick-caused reload while QueryBar's spinner (driven by the full
  // `loading` below, unchanged) keeps firing on every reload.
  const tickNav = useTickNavigation();

  const [draft, setDraft] = useEditBuffer(pane.query);

  // Null on both means the pane is still resolving its default half (see
  // useComparisonParams) rather than a range the user brushed or deep-linked
  // — worth calling out, since the default is otherwise invisible.
  const isDefaultWindow =
    pane.fromOverride == null && pane.untilOverride == null;
  const hasOverride = pane.fromOverride != null || pane.untilOverride != null;
  // The qualifier leads rather than trails: .panel-meta ellipsizes from the
  // end under width pressure, and the timestamps it would cut are already
  // visible on the timeline's brush — "first/second half" is the one thing
  // here with no other home, so it has to be what survives truncation.
  const meta = isDefaultWindow
    ? `${pane.side === 'left' ? 'first' : 'second'} half · ${formatPaneWindow(pane.range)}`
    : formatPaneWindow(pane.range);

  return (
    <Panel
      title={title}
      meta={meta}
      actions={
        // Panel treats `actions != null` as "render the slot", so a plain
        // `hasOverride && <Button>` would leave an empty one behind once
        // `hasOverride` goes false (`false != null` is true). Fall through
        // to `null` instead.
        hasOverride ? (
          <Button
            // Comparison and Diff can land both panes in the override state
            // at once (Swap, Compare-vs-previous), giving two buttons the
            // same visible "Reset window" label — indistinguishable by
            // accessible name alone. `title` is "Baseline" / "Comparison" in
            // both views, so lowercasing it into the label disambiguates
            // them without changing what's on screen.
            aria-label={`Reset ${title.toLowerCase()} window`}
            onClick={() =>
              // Only the range params: the query bar owns `<side>Query` and
              // resets it on its own terms, so this stays a window reset,
              // not a "start over" that would surprise whoever brushed the
              // range but kept the query they typed.
              navigate({
                set: {
                  [`${pane.side}From`]: null,
                  [`${pane.side}Until`]: null,
                },
              })
            }
          >
            Reset window
          </Button>
        ) : null
      }
    >
      <div className="comparison-pane">
        <QueryBar
          query={draft}
          committedQuery={pane.query}
          onQueryChange={setDraft}
          onRun={(q) => navigate({ set: { [`${pane.side}Query`]: q } })}
          start={mainRange.start}
          end={mainRange.end}
          tenantID={tenantID}
          loading={loading}
        />
        {error && <ErrorBanner error={error} retry={retry} />}
        <TimeSeries
          data={timeline}
          timeRange={mainFrom}
          profileTypeId={profileTypeID}
          startMs={mainRange.start}
          endMs={mainRange.end}
          selection={pane.range}
          loading={(loading && !tickNav) || settlingQuery}
          onRangeSelect={(start, end) =>
            navigate({
              set: {
                [`${pane.side}From`]: String(start),
                [`${pane.side}Until`]: String(end),
              },
            })
          }
        />
        {children}
      </div>
    </Panel>
  );
}
