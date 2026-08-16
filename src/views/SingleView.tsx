import type { ViewProps } from '../App';
import { ControlsBar } from '@components/ControlsBar';
import { FlameGraph } from '@components/FlameGraph';
import { Panel } from '@components/Panel';
import { Button } from '@components/core/Button';
import { QueryBar } from '@components/QueryBar';
import { TimeSeries } from '@components/TimeSeries';
import { useFlamegraph, useTimeline } from '@hooks/useProfileData';
import { useEditBuffer } from '@hooks/useEditBuffer';
import { parseMaxNodes, profileTypeLabel } from '@api/client';
import { parseQuery, splitQuery } from '../queryLang';
import { formatRangeLabel } from '../time';
import { navigate, useRoute } from '../urlState';
import { ErrorBanner } from './ComparisonPane';
import { previousPeriodParams } from './comparisonParams';

// Kept local rather than exported from a shared module: react-refresh's
// lint rule requires a component file's exports to be components only, so
// ComparisonView.tsx duplicates this rather than importing it.
const FLAMEGRAPH_EMPTY_MESSAGE =
  'No profiles matched this query in this range. Recently ingested ' +
  'profiles can take about a minute to become queryable.';

function isLast24h(from: string, until: string): boolean {
  return from === 'now-24h' && until === 'now';
}

export function SingleView({
  services,
  servicesLoading,
  query,
  from,
  until,
  range,
  tenantID,
}: ViewProps) {
  const { params } = useRoute();
  const maxNodes = parseMaxNodes(params.get('maxNodes'));
  const fg = useFlamegraph({ query, range, tenantID, maxNodes });
  const tl = useTimeline({ query, range, tenantID });
  const error = fg.error ?? tl.error;
  // A single banner can only show one message, but when both hooks failed a
  // Retry that only re-ran one of them looked dead: the banner would just
  // swap to the other hook's identical-looking error. So Retry composes
  // every hook that actually has a fetch error (undefined ones — malformed
  // query, or the other hook succeeded — drop out).
  const retries = [
    fg.error ? fg.retry : undefined,
    tl.error ? tl.retry : undefined,
  ].filter((r): r is () => void => !!r);
  const retry =
    retries.length > 0 ? () => retries.forEach((r) => r()) : undefined;
  const { profileTypeID } = splitQuery(query);
  const parsed = parseQuery(query);

  const [draft, setDraft] = useEditBuffer(query);

  return (
    <div className="app-content">
      <ControlsBar
        services={services}
        servicesLoading={servicesLoading}
        query={query}
        from={from}
        until={until}
        range={range}
      />

      <QueryBar
        query={draft}
        committedQuery={query}
        onQueryChange={setDraft}
        onRun={(q) => navigate({ set: { query: q } })}
        start={range.start}
        end={range.end}
        tenantID={tenantID}
        loading={fg.loading || tl.loading}
      />

      {error && <ErrorBanner error={error} retry={retry} />}

      <Panel
        title="Timeline"
        meta={tl.loading ? 'Loading…' : formatRangeLabel(from, until, range)}
      >
        <TimeSeries
          data={tl.timeline}
          timeRange={from}
          profileTypeId={profileTypeID}
          startMs={range.start}
          endMs={range.end}
          onRangeSelect={(start, end) =>
            navigate({ set: { from: String(start), until: String(end) } })
          }
        />
      </Panel>

      <Panel
        title="Flamegraph"
        actions={
          // Before the default query resolves (a bare "/" on first load),
          // `query` is '' and splitQuery's profileTypeID comes back empty.
          // Clicking either action then would write an explicit but empty
          // leftQuery/rightQuery, which `params.get('leftQuery') ?? mainQuery`
          // treats as a real override (empty string is not nullish) — pinning
          // both panes to "no query" forever instead of inheriting whatever
          // the main query resolves to a moment later. Hiding the actions
          // until there is a real query to branch from avoids that.
          profileTypeID ? (
            <>
              <Button
                onClick={() =>
                  navigate({
                    path: '/comparison',
                    set: previousPeriodParams(query, from, until, range),
                  })
                }
              >
                Compare vs previous
              </Button>
              <Button
                onClick={() =>
                  navigate({
                    path: '/diff',
                    set: previousPeriodParams(query, from, until, range),
                  })
                }
              >
                Diff vs previous
              </Button>
            </>
          ) : undefined
        }
        meta={
          fg.loading
            ? 'Loading…'
            : parsed
              ? `${parsed.service} · ${profileTypeLabel(parsed.profileType)}`
              : undefined
        }
      >
        <FlameGraph
          data={fg.flamegraph}
          profileTypeId={profileTypeID}
          loading={fg.loading}
          // Suppressed while fg has its own error: the banner above already
          // explains it, and offering "no profiles matched" plus an action
          // that widens the range would misstate a fetch failure as an
          // empty result.
          empty={
            fg.error
              ? undefined
              : {
                  message: FLAMEGRAPH_EMPTY_MESSAGE,
                  action: isLast24h(from, until)
                    ? undefined
                    : {
                        label: 'Last 24 hours',
                        // Single has no pane sub-ranges to clear (unlike
                        // ComparisonView's identical action) — this widens
                        // the only range there is.
                        onClick: () =>
                          navigate({ set: { from: 'now-24h', until: null } }),
                      },
                }
          }
        />
      </Panel>
    </div>
  );
}
