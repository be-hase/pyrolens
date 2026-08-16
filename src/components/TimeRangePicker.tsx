import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '@components/core/Button';
import { Dropdown } from '@components/core/Dropdown';
import { Icon } from '@components/core/Icon';
import { copyText } from '../clipboard';
import { formatRangeLabel, isRelative, type TimeRange } from '../time';
import { navigate } from '../urlState';
import './TimeRangePicker.css';

// Grouped as minutes / hours / days; a divider separates the groups.
const PRESET_GROUPS = [
  [
    { label: 'Last 5 minutes', value: 'now-5m' },
    { label: 'Last 15 minutes', value: 'now-15m' },
    { label: 'Last 30 minutes', value: 'now-30m' },
  ],
  [
    { label: 'Last 1 hour', value: 'now-1h' },
    { label: 'Last 3 hours', value: 'now-3h' },
    { label: 'Last 6 hours', value: 'now-6h' },
    { label: 'Last 12 hours', value: 'now-12h' },
    { label: 'Last 24 hours', value: 'now-24h' },
  ],
  [
    { label: 'Last 2 days', value: 'now-2d' },
    { label: 'Last 7 days', value: 'now-7d' },
    { label: 'Last 30 days', value: 'now-30d' },
  ],
];

/** Unix ms → "YYYY-MM-DD HH:mm:ss" in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Parses "YYYY-MM-DD HH:mm[:ss]" (or with a T separator) as local time. */
function parseLocalInput(value: string): number {
  const m = value
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  // Reject rollovers like month 13, 25:00, or :99 that Date() accepts.
  const faithful =
    date.getMonth() === Number(mo) - 1 &&
    date.getHours() === Number(h) &&
    date.getMinutes() === Number(mi) &&
    date.getSeconds() === Number(s ?? 0);
  return faithful ? date.getTime() : NaN;
}

// Strict ISO-8601 with an explicit zone (`Z` or `±hh:mm`) — the shape
// `toISOString()` produces and the shape Grafana's own paste path
// (`toUtcDateTimeIfIsoString`) looks for. A bare `YYYY-MM-DDTHH:mm:ss` with no
// zone is deliberately rejected here rather than guessed at: it is ambiguous
// between "this is UTC" and "this is local", and `parseLocalInput` below
// already claims that exact shape (with a `T` or space separator) as local.
// Captures Y/Mo/D/H/Mi/S so `parseClipboardTimeValue` can round-trip them
// through `Date.UTC` and catch a rolled-over date `Date.parse` alone would
// not.
const ISO_UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

// year 9999, the largest a 4-digit-year ISO string can express.
const MAX_EPOCH_MS = 253_402_300_799_999;

// `resolveTime` (src/time.ts) treats any URL number below this as unix
// SECONDS rather than ms — its own heuristic for accepting the classic UI's
// second-based URLs. A pasted ms value under that threshold (any instant
// within about the first 47 days after the epoch) would silently be
// reinterpreted by that heuristic as a wildly later date the moment the URL
// it was written to gets read back — accepting it here would not be a no-op
// on a bad value, it would be *becoming* a bad value.
const MIN_EPOCH_MS = 4_102_444_800;

/**
 * Clamps a parsed clipboard timestamp to values that could plausibly have
 * come from a real date and survive the round trip through the URL: an
 * integer libraries can do arithmetic on losslessly (`Number.isSafeInteger`)
 * inside the range `resolveTime` (src/time.ts) itself treats as milliseconds
 * rather than seconds or nonsense. Without the upper end, a 300-digit numeric
 * string or a `now-`-prefixed value with a 20-digit count (both shape-valid
 * to their respective branches below) would sail through as `Infinity`/an
 * unrepresentable magnitude — the clipboard is untrusted input, so the bound
 * is enforced here rather than trusted to whatever reads the URL param next.
 */
function boundedMs(ms: number): { ms: number } | null {
  return Number.isSafeInteger(ms) && ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS
    ? { ms }
    : null;
}

/**
 * One value from a Grafana-clipboard time range, tried in order: pyrolens/
 * Grafana relative syntax ("now", "now-6h" — validated with the same rule
 * `isRelative` uses everywhere else, rather than a second regex that could
 * drift from it, plus a digit-count cap `isRelative` itself does not have);
 * strict ISO-8601 with a zone, the shape `toISOString()` produces and current
 * Grafana pastes; an all-digits unix-ms string; or a local
 * "YYYY-MM-DD HH:mm[:ss]" string, the shape older Grafana versions wrote and
 * still the shape pyrolens's own absolute form uses. `null` for anything
 * else, including any of the above outside a sane epoch — the clipboard is
 * untrusted input.
 *
 * The ISO branch additionally rejects a calendrically impossible date (Feb
 * 30, say) rather than trusting `Date.parse` to have: engines are not
 * required to reject one, and V8 in particular rolls it over into the next
 * valid date instead of returning `NaN`, silently landing on a date the
 * clipboard text never named. `parseLocalInput` above already guards the
 * same mistake for the local-format branch with the same round-trip idiom.
 */
function parseClipboardTimeValue(
  value: string,
): { relative: string } | { ms: number } | null {
  if (isRelative(value)) {
    const rel = value.match(/^now-(\d+)[smhdw]$/);
    if (rel && rel[1].length > 7) return null;
    return { relative: value };
  }
  const iso = value.match(ISO_UTC_RE);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso.map(Number);
    const roundTrip = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const faithful =
      roundTrip.getUTCFullYear() === y &&
      roundTrip.getUTCMonth() === mo - 1 &&
      roundTrip.getUTCDate() === d &&
      roundTrip.getUTCHours() === h &&
      roundTrip.getUTCMinutes() === mi &&
      roundTrip.getUTCSeconds() === s;
    // The instant itself still comes from Date.parse on the original string,
    // not from Date.UTC above — that round trip only proves the wall-clock
    // digits are a real calendar date, its own zone offset (if any) was
    // ignored on purpose to keep the check independent of it.
    return faithful ? boundedMs(Date.parse(value)) : null;
  }
  if (/^\d+$/.test(value)) return boundedMs(Number(value));
  const ms = parseLocalInput(value);
  return Number.isFinite(ms) ? boundedMs(ms) : null;
}

/**
 * Grafana's copy-time-range clipboard format: `{"from":...,"to":...}`, each
 * side either relative syntax or an absolute timestamp (ISO-8601 with a zone,
 * or the older local "YYYY-MM-DD HH:mm:ss" with none — see
 * `parseClipboardTimeValue`). Parsed strictly — anything that does not fit is
 * a no-op rather than a guess, since this text can come from anywhere the
 * user last copied from.
 */
function parseClipboardRange(
  text: string,
): { from: string; until: string | null } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return null;
  }
  const { from: rawFrom, to: rawTo } = obj as Record<string, unknown>;
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') return null;

  const from = parseClipboardTimeValue(rawFrom);
  const to = parseClipboardTimeValue(rawTo);
  if (!from || !to) return null;

  return {
    from: 'relative' in from ? from.relative : String(from.ms),
    until:
      rawTo === 'now' ? null : 'relative' in to ? to.relative : String(to.ms),
  };
}

/**
 * Captures a shape-valid "YYYY-MM-DD" from the start of the input, but only
 * if it survives a round trip through Date() — the same faithfulness idiom
 * `parseLocalInput` uses. Date() happily rolls month 13 into next January, so
 * without this check the calendar would anchor to (and highlight) a month
 * that was never actually entered.
 */
function selectedDateKey(value: string): string {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [whole, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  const faithful =
    date.getFullYear() === Number(y) &&
    date.getMonth() === Number(mo) - 1 &&
    date.getDate() === Number(d);
  return faithful ? whole : '';
}

/** "2h 30m" style summary of the drafted absolute range. */
function formatDuration(ms: number): string {
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ];
  const parts: string[] = [];
  let rest = ms;
  for (const [suffix, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0 && parts.length < 2) {
      parts.push(`${n}${suffix}`);
      rest -= n * size;
    }
  }
  return parts.length ? parts.join(' ') : '0s';
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * Local "YYYY-MM-DD" for a Date. Defined via `toLocalInput` because the
 * calendar compares these keys against the date part of the input field —
 * two independent formatters would let the two drift and silently break the
 * selected/today highlighting.
 */
function toDateKey(d: Date): string {
  return toLocalInput(d.getTime()).slice(0, 10);
}

// Custom month-grid calendar, so the picker looks the same in every browser
// and locale (the native date popup follows the browser UI language).
function CalendarPopover({
  selected,
  todayKey,
  onPick,
}: {
  /** Currently selected "YYYY-MM-DD", or '' when the field is invalid. */
  selected: string;
  todayKey: string;
  onPick: (dateKey: string) => void;
}) {
  const [view, setView] = useState(() => {
    const base = selected || todayKey;
    return {
      year: Number(base.slice(0, 4)),
      month: Number(base.slice(5, 7)) - 1,
    };
  });

  // Same previous-value-during-render pattern as useEditBuffer and the
  // `committed` state above: `selected` is derived from the field text, which
  // moves when the URL range moves underneath an open picker (Back/Forward)
  // or when the user types a different date. Re-deriving the view here keeps
  // the open month grid following it instead of showing a stale month with no
  // highlighted day. An empty `selected` — empty field text, or text whose
  // date part is shape-valid but not a real date (month 13, say) — is not a
  // date to re-anchor to, so the view is left where it was.
  const [previousSelected, setPreviousSelected] = useState(selected);
  if (previousSelected !== selected) {
    setPreviousSelected(selected);
    if (selected) {
      setView({
        year: Number(selected.slice(0, 4)),
        month: Number(selected.slice(5, 7)) - 1,
      });
    }
  }

  const shift = (delta: number) => {
    setView(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const first = new Date(view.year, view.month, 1);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(view.year, view.month, 1 - first.getDay() + i));
  }

  return (
    <div className="trp-cal-pop" role="dialog" aria-label="Choose date">
      <div className="trp-cal-head">
        <button
          type="button"
          className="trp-cal-nav"
          aria-label="Previous month"
          onClick={() => shift(-1)}
        >
          <Icon name="angle-left" size={14} />
        </button>
        <span className="trp-cal-title">
          {MONTHS[view.month]} {view.year}
        </span>
        <button
          type="button"
          className="trp-cal-nav"
          aria-label="Next month"
          onClick={() => shift(1)}
        >
          <Icon name="angle-right" size={14} />
        </button>
      </div>
      <div className="trp-cal-grid">
        {WEEKDAYS.map((d) => (
          <span key={d} className="trp-dow">
            {d}
          </span>
        ))}
        {cells.map((d) => {
          const key = toDateKey(d);
          const cls = [
            'trp-day',
            d.getMonth() !== view.month && 'dim',
            key === todayKey && 'today',
            key === selected && 'selected',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={key}
              type="button"
              className={cls}
              onClick={() => onPick(key)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// One From/To row: an ISO text input plus a calendar button that opens the
// custom calendar — picking a day replaces the date part and keeps the time
// part.
function DateTimeField({
  label,
  value,
  invalid,
  onChange,
  onEnter,
}: {
  label: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  // todayKey is captured when the calendar opens, keeping render pure.
  const [cal, setCal] = useState<{ open: boolean; todayKey: string }>({
    open: false,
    todayKey: '',
  });

  const selected = selectedDateKey(value);

  const onPickDate = (picked: string) => {
    const time =
      value.trim().match(/[T ](\d{1,2}:\d{2}(?::\d{2})?)$/)?.[1] ?? '00:00:00';
    onChange(`${picked} ${time}`);
    setCal((c) => ({ ...c, open: false }));
  };

  return (
    <label className="trp-field">
      <span className="trp-field-label">{label}</span>
      <span className="trp-field-input">
        <input
          type="text"
          spellCheck={false}
          placeholder="YYYY-MM-DD HH:mm:ss"
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        />
        <button
          type="button"
          className="trp-cal"
          aria-label={`Pick ${label.toLowerCase()} date`}
          aria-expanded={cal.open}
          onClick={() =>
            setCal((c) => ({
              open: !c.open,
              todayKey: toDateKey(new Date()),
            }))
          }
        >
          <Icon name="calendar" size={14} />
        </button>
        <Dropdown
          open={cal.open}
          onClose={() => setCal((c) => ({ ...c, open: false }))}
          align="right"
          className="trp-cal-drop"
        >
          <CalendarPopover
            selected={selected}
            todayKey={cal.todayKey}
            onPick={onPickDate}
          />
        </Dropdown>
      </span>
    </label>
  );
}

// Time range picker: a Grafana-style absolute From/To form next to the
// relative presets. Presets write `from=now-*` (clearing `until`); the
// absolute form writes both bounds as unix ms, which the whole app already
// understands, so absolute views stay shareable by URL.
export function TimeRangePicker({
  from,
  until,
  range,
}: {
  from: string;
  until: string;
  /** `from`/`until` as App resolved them, so the label and the drafted
   * absolute bounds agree with what the charts actually fetched. */
  range: TimeRange;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from: '', until: '' });
  const [copyLabel, setCopyLabel] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  // copyTimer is the pending idle-revert; copyGeneration is what guards it.
  // Each click bumps the generation and captures it, and a `.then` callback
  // only acts if its capture is still current — see copyLink for why that
  // check (and the clear/reschedule of copyTimer) has to happen there rather
  // than at click time. Bumping it in the unmount cleanup too means a
  // `writeText` that resolves after unmount finds itself stale as well.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const copyGeneration = useRef(0);

  // Same idle-revert/generation pair as copyTimer/copyGeneration above, kept
  // separate because it drives a different piece of UI (the trigger button's
  // own label, for the `t c`/`t v` shortcuts, rather than the dropdown's copy
  // button) — sharing one pair would let a dropdown copy's revert clobber an
  // in-flight `t c`/`t v` feedback or vice versa. `pasteFailed` is distinct
  // from `failed` (a failed *copy*) so the two shortcuts don't get each
  // other's wording.
  const [triggerCopyLabel, setTriggerCopyLabel] = useState<
    'idle' | 'copied' | 'failed' | 'pasteFailed'
  >('idle');
  const triggerCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const triggerCopyGeneration = useRef(0);

  // Guards `t v` against a stale clipboard read: readText() can resolve after
  // the user has already navigated elsewhere (or after unmount), and a
  // navigate() from that resolution would silently override whatever they
  // did next. Bumped for every new paste (invalidating a still-pending
  // earlier one) and by the keydown effect's own 'pyroscope:navigate'/
  // 'popstate' listeners below, registered for exactly this — the effect's
  // *cleanup* also bumps it, but cleanup is a passive effect that runs after
  // a navigation already committed, leaving a window where a readText()
  // settling in between would still see the old generation as current. The
  // cleanup bump stays too, for unmount (which fires no navigation event).
  const pasteGeneration = useRef(0);

  // Same previous-value-during-render pattern as useEditBuffer: from/until
  // are the URL strings App resolved `range` from, so they are what to
  // anchor on. range.start/end is not stable enough — for a relative range
  // "now" advances on every navigation, which would reset an open picker's
  // draft on a navigation that changed nothing about the range itself.
  const [committed, setCommitted] = useState({ from, until });
  if (committed.from !== from || committed.until !== until) {
    setCommitted({ from, until });
    // Closed pickers already re-derive fresh in openPicker; only an open one
    // needs re-anchoring, or Apply would write back a range Back/Forward
    // already moved the URL away from.
    if (open) {
      setDraft({
        from: toLocalInput(range.start),
        until: toLocalInput(range.end),
      });
    }
  }

  const openPicker = () => {
    setDraft({
      from: toLocalInput(range.start),
      until: toLocalInput(range.end),
    });
    setOpen(true);
  };

  const draftFromMs = parseLocalInput(draft.from);
  const draftUntilMs = parseLocalInput(draft.until);
  const fromOk = Number.isFinite(draftFromMs);
  const untilOk = Number.isFinite(draftUntilMs);
  const valid = fromOk && untilOk && draftFromMs < draftUntilMs;

  const apply = () => {
    if (!valid) return;
    setOpen(false);
    navigate({
      set: { from: String(draftFromMs), until: String(draftUntilMs) },
    });
  };

  const onPreset = (value: string) => {
    setOpen(false);
    navigate({ set: { from: value, until: null } });
  };

  useEffect(
    () => () => {
      copyGeneration.current += 1;
      clearTimeout(copyTimer.current);
      triggerCopyGeneration.current += 1;
      clearTimeout(triggerCopyTimer.current);
    },
    [],
  );

  // Four bindings, all sharing one keydown listener: `y` (GitHub's
  // canonical-URL mnemonic) switches the range to absolute; Grafana's `t`
  // sequences are kept as aliases for muscle memory carried over from there —
  // `t a` also switches to absolute, `t c` copies the range to the clipboard
  // in Grafana's own JSON format, `t v` pastes it back. Re-registers whenever
  // `range`, `from` or `until` change so the handler always closes over what
  // is currently on screen rather than a snapshot from whenever the listener
  // was first attached; pressing a binding while already on the range it
  // would produce writes a byte-identical URL, which navigate() already
  // turns into a no-op replaceState (see src/urlState.ts) rather than a new
  // history entry.
  //
  // `t ...` is tracked as a pending-prefix ref rather than component state,
  // so re-renders (every keystroke of the eventual sequence is one) don't
  // reset it. The ref does *not* survive this effect re-registering, though:
  // the cleanup below disarms it on every dep change, same as on unmount.
  // That is intentional rather than incidental — the deps only change on a
  // navigation, and a navigation cannot happen between two keystrokes of a
  // sequence the user is still typing, so resetting here only ever catches a
  // prefix left armed by whatever navigated (a click, another shortcut) and
  // never a legitimate one. `pasteGeneration` (above) needs the same
  // invalidation on a navigation, but *not* only through this cleanup — see
  // the dedicated listeners registered alongside the keydown one below.
  const tPending = useRef(false);
  const tTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const disarm = () => {
      tPending.current = false;
      clearTimeout(tTimeout.current);
    };
    const rearm = () => {
      clearTimeout(tTimeout.current);
      tTimeout.current = setTimeout(disarm, 1000);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const guarded = () => {
        if (e.defaultPrevented) return true;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return true;
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        return (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          !!target?.isContentEditable
        );
      };
      const absolute = () =>
        navigate({
          set: { from: String(range.start), until: String(range.end) },
        });

      // The trigger button's transient label is shared by `t c`'s outcome and
      // `t v`'s failure. Both directions are guarded by triggerCopyGeneration:
      // this bumps it, so `copyRange`'s own check (below) bails if a `t v`
      // failure landed while its write was still in flight, rather than
      // overwriting "Paste failed" with a stale "Copied"/"Copy failed".
      // Guarding the other direction — a `t v` failure arriving after a newer
      // `t c` already reported its own outcome — is `pasteRange`'s job: it
      // has to capture triggerCopyGeneration *before* calling this, so the
      // check lives there rather than in here.
      const failPaste = () => {
        triggerCopyGeneration.current += 1;
        clearTimeout(triggerCopyTimer.current);
        setTriggerCopyLabel('pasteFailed');
        triggerCopyTimer.current = setTimeout(
          () => setTriggerCopyLabel('idle'),
          1500,
        );
      };

      // `t c`: write Grafana's clipboard JSON. Each endpoint is formatted by
      // what it actually is — the URL params are the source of truth for
      // relativeness, independently per side — rather than by whether `from`
      // happens to be relative: after pasting a mixed range (an absolute
      // `from`, a relative `until` of "now") copying both sides as absolute
      // would freeze what should still be a moving window. An absolute side
      // is written as `toISOString()`, matching current Grafana
      // (`toUtcDateTimeIfIsoString` in its source) and sidestepping the
      // fall-back DST ambiguity a local wall-clock string has twice a year
      // (2026-11-01 01:30 America/New_York happens twice; its UTC instant
      // does not).
      const copyRange = () => {
        const untilValue = until || 'now';
        const payload = {
          from: isRelative(from) ? from : new Date(range.start).toISOString(),
          to: isRelative(untilValue)
            ? untilValue
            : new Date(range.end).toISOString(),
        };
        const generation = ++triggerCopyGeneration.current;
        copyText(JSON.stringify(payload)).then((ok) => {
          if (generation !== triggerCopyGeneration.current) return;
          clearTimeout(triggerCopyTimer.current);
          setTriggerCopyLabel(ok ? 'copied' : 'failed');
          triggerCopyTimer.current = setTimeout(
            () => setTriggerCopyLabel('idle'),
            1500,
          );
        });
      };

      // `t v`: read the clipboard and, if it strictly parses as Grafana's
      // format, navigate to it. `readText` needs a secure context; there is
      // no legacy fallback to read the clipboard (unlike copyText's write
      // path, `execCommand('paste')` was removed everywhere long ago), so an
      // insecure deployment reports the same "Paste failed" as a bad parse
      // rather than pretending nothing was pressed.
      //
      // `generation` guards against a stale navigate(): readText() can settle
      // after the user has already navigated elsewhere — a preset click, the
      // popstate from Back, another shortcut — or after unmount, and a
      // navigate() from that late arrival would silently override whatever
      // happened since. `triggerGeneration` is a second, independent capture
      // for the *label*: a newer `t c` reporting "Copied"/"Copy failed" while
      // this read is still in flight must not be overwritten by this paste's
      // late "Paste failed" (see the comment on failPaste above) — captured
      // at dispatch, before either async path below can run, since nothing
      // else can move triggerCopyGeneration between here and readText()
      // actually starting.
      const pasteRange = () => {
        if (!navigator.clipboard?.readText) {
          // Synchronous: nothing else can have run since this call started,
          // so there is no newer outcome to protect and no staleness check
          // is needed here.
          failPaste();
          return;
        }
        const generation = ++pasteGeneration.current;
        const triggerGeneration = triggerCopyGeneration.current;
        navigator.clipboard
          .readText()
          .then((text) => {
            if (generation !== pasteGeneration.current) return;
            const parsed = parseClipboardRange(text);
            if (!parsed) {
              if (triggerGeneration === triggerCopyGeneration.current) {
                failPaste();
              }
              return;
            }
            navigate({ set: { from: parsed.from, until: parsed.until } });
          })
          .catch(() => {
            if (generation !== pasteGeneration.current) return;
            if (triggerGeneration === triggerCopyGeneration.current) {
              failPaste();
            }
          });
      };

      if (tPending.current) {
        // An unguarded `t` restarts the window instead of acting or
        // cancelling — holding the key (key-repeat) or retyping it should
        // still lead into `t a`/`t c`/`t v`, not swallow the sequence.
        if (e.key === 't' && !guarded()) {
          rearm();
          return;
        }
        // Any other key disarms the sequence, guarded or not; only an
        // unguarded `a`/`y` (switch to absolute), `c` (copy) or `v` (paste)
        // also acts.
        const eligible = !guarded();
        const key = e.key;
        disarm();
        if (!eligible) return;
        if (key === 'a' || key === 'y') {
          absolute();
        } else if (key === 'c') {
          copyRange();
        } else if (key === 'v') {
          pasteRange();
        }
        return;
      }

      if (guarded()) return;
      if (e.key === 'y') {
        absolute();
        return;
      }
      if (e.key === 't') {
        tPending.current = true;
        rearm();
      }
    };
    // Bumps pasteGeneration on the same synchronous events navigate()
    // dispatches (see src/urlState.ts's NAV_EVENT — 'popstate' covers
    // Back/Forward, which navigate() does not go through) — the same
    // "outside React, before any effect" pattern App.tsx's tenant-header sync
    // uses, and for the same reason: this effect's own cleanup only runs as a
    // passive effect *after* React commits the re-render a navigation
    // triggers, which is too late to catch a readText() that settles in that
    // gap.
    const bumpPasteGeneration = () => {
      pasteGeneration.current += 1;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pyroscope:navigate', bumpPasteGeneration);
    window.addEventListener('popstate', bumpPasteGeneration);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pyroscope:navigate', bumpPasteGeneration);
      window.removeEventListener('popstate', bumpPasteGeneration);
      disarm();
      pasteGeneration.current += 1;
    };
  }, [range, from, until]);

  // Bakes the resolved bounds into the current URL and copies that, without
  // navigating: the recipient sees the window this screen showed, while this
  // screen stays on its relative range so it keeps advancing. Only from/until
  // need baking — the Comparison/Diff pane params (leftFrom/leftUntil/...)
  // resolve against `now = mainRange.end` (see comparisonParams.ts), and
  // baking `until` to that same instant means even a relative pane param
  // resolves to identical bounds for the recipient.
  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('from', String(range.start));
    url.searchParams.set('until', String(range.end));
    const generation = ++copyGeneration.current;
    copyText(url.toString()).then((ok) => {
      // A click's own writeText can still be pending when a later click (or
      // an unmount) happens, so clearing/scheduling copyTimer can only be
      // done once this attempt is known to still be the current one — doing
      // either at click time, before writeText has resolved, clears/races
      // against a timer that does not exist yet.
      if (generation !== copyGeneration.current) return;
      clearTimeout(copyTimer.current);
      setCopyLabel(ok ? 'copied' : 'failed');
      copyTimer.current = setTimeout(() => setCopyLabel('idle'), 1500);
    });
  };

  const relativeActive = isRelative(from) && (until === 'now' || !until);

  return (
    <div className="time-range-picker">
      <Button
        icon={triggerCopyLabel === 'copied' ? 'check' : 'history-alt'}
        iconRight="angle-down"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        {triggerCopyLabel === 'copied'
          ? 'Copied'
          : triggerCopyLabel === 'failed'
            ? 'Copy failed'
            : triggerCopyLabel === 'pasteFailed'
              ? 'Paste failed'
              : formatRangeLabel(from, until, range)}
      </Button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        className="trp"
        role="dialog"
        label="Time range"
      >
        <div className="trp-absolute">
          <div className="trp-heading">Absolute range</div>
          <DateTimeField
            label="From"
            value={draft.from}
            invalid={!fromOk}
            onChange={(v) => setDraft({ ...draft, from: v })}
            onEnter={apply}
          />
          <DateTimeField
            label="To"
            value={draft.until}
            invalid={!untilOk}
            onChange={(v) => setDraft({ ...draft, until: v })}
            onEnter={apply}
          />
          <div className={valid ? 'trp-hint' : 'trp-hint trp-hint-error'}>
            {valid
              ? `${formatDuration(draftUntilMs - draftFromMs)} range`
              : !fromOk || !untilOk
                ? 'Use YYYY-MM-DD HH:mm:ss (local time)'
                : 'End must be after start'}
          </div>
          <Button
            variant="primary"
            className="trp-apply"
            disabled={!valid}
            onClick={apply}
          >
            Apply time range
          </Button>
          <Button
            icon={copyLabel === 'copied' ? 'check' : 'copy'}
            className="trp-copy-link"
            onClick={copyLink}
          >
            {copyLabel === 'copied'
              ? 'Copied'
              : copyLabel === 'failed'
                ? 'Copy failed'
                : 'Copy absolute link'}
          </Button>
        </div>
        <div className="trp-presets">
          <div className="trp-heading">Quick ranges</div>
          <div className="trp-preset-list">
            {PRESET_GROUPS.map((group, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <div className="dropdown-divider" />}
                {group.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={
                      relativeActive && from === p.value
                        ? 'trp-preset active'
                        : 'trp-preset'
                    }
                    onClick={() => onPreset(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      </Dropdown>
    </div>
  );
}
