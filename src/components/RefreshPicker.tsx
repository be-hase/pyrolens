import { useEffect } from 'react';
import { Select } from '@components/core/Select';
import { fetchesInFlight } from '@api/client';
import { navigate, useRoute } from '../urlState';

// The interval presets, in the order the dropdown lists them. `value` is
// exactly what lands in the `refresh` URL param — except OFF_VALUE, a
// sentinel for Select's single required value that means "no `refresh`
// param at all" rather than a literal one.
const OFF_VALUE = 'off';
const PRESETS = [
  { label: '10s', value: '10s', ms: 10_000 },
  { label: '30s', value: '30s', ms: 30_000 },
  { label: '1m', value: '1m', ms: 60_000 },
  { label: '5m', value: '5m', ms: 300_000 },
];
const OPTIONS = [
  { label: 'Off', value: OFF_VALUE },
  ...PRESETS.map(({ label, value }) => ({ label, value })),
];

/** Resolves a `refresh` URL value to its interval in ms, or null for
 * anything absent or unrecognised — invalid input is silently treated as
 * off rather than corrected in the URL, since the URL is user input. */
function parseRefresh(value: string | null): number | null {
  return PRESETS.find((p) => p.value === value)?.ms ?? null;
}

// Auto-refresh picker, rendered next to TimeRangePicker. The interval lives
// in the `refresh` URL param like everything else; ticking is implemented by
// calling navigate({ set: {} }) on a timer, the same no-op-but-still-fires
// navigation Run uses, so it advances the frozen "now" and refires every
// relative-range fetch without any refresh mechanism of its own.
//
// Built on core/Select, which already has the listbox/option/aria-selected
// semantics this widget needs — a menu-flavoured popup of plain buttons
// looked like a menu (aria-haspopup="menu", role="menu") without any of a
// menu's keyboard/focus behaviour, and the active preset was conveyed by
// colour alone.
export function RefreshPicker({
  from,
  until,
}: {
  from: string;
  until: string;
}) {
  // Accepted (and kept in the type) for symmetry with TimeRangePicker, which
  // ControlsBar passes the same from/until pair to — but eligibility below
  // depends only on `until`, so `from` itself is unread; see the comment on
  // `relativeActive`.
  void from;

  const { params } = useRoute();
  const refreshParam = params.get('refresh');
  const interval = parseRefresh(refreshParam);

  // Eligibility is about whether the END moves, not the start: a tick
  // advances "now", and a moving end is exactly what that means for the
  // range on screen. A pinned start (e.g. clipboard interop deliberately
  // produces `from=<absolute ms>&until=now` — a fixed start, a moving end)
  // is irrelevant to that question, so this must not also require
  // `isRelative(from)` — that made a mixed range show an interval that never
  // ticked, with no feedback that it was inert.
  const relativeActive = until === 'now' || !until;

  // Ticking is only armed when there is a known interval AND the range is
  // relative-ending-at-now; re-registers whenever either changes so a range
  // that goes absolute (or a param edit) stops/starts the timer rather than
  // ticking against stale conditions captured at mount.
  useEffect(() => {
    if (!interval || !relativeActive) return;

    let timerId: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timerId !== undefined) clearInterval(timerId);
      timerId = undefined;
    };
    const start = () => {
      timerId = setInterval(() => {
        // A query slower than the interval is still in flight from an
        // earlier tick (routine for a large profile); navigating again
        // would abort it and reissue an identical one, so nothing ever
        // completes. Skipping beats queueing: the next interval tick
        // retries, so a query that finished in the meantime is refreshed at
        // most one interval late, and one that hasn't is left to run,
        // bounded by the transport's own timeout upstream rather than by
        // anything this component does.
        if (fetchesInFlight() > 0) return;
        navigate({ set: {} });
      }, interval);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        // A backgrounded tab must not keep queuing paints nobody sees.
        stop();
      } else {
        // On return the user wants fresh data now, not up to `interval`
        // later — fire once immediately, then resume the normal cadence.
        // Same in-flight check as the tick: a request from just before the
        // tab was hidden may still be outstanding.
        if (fetchesInFlight() === 0) navigate({ set: {} });
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [interval, relativeActive]);

  // Label reflects the URL value even while the range is absolute (and
  // ticking is dormant) — switching back to a relative range should not
  // require re-picking the interval, so the control keeps showing it.
  const value = interval !== null ? (refreshParam as string) : OFF_VALUE;

  return (
    <Select
      value={value}
      options={OPTIONS}
      icon="refresh"
      label="Refresh interval"
      onChange={(v) =>
        navigate({ set: { refresh: v === OFF_VALUE ? null : v } })
      }
    />
  );
}
