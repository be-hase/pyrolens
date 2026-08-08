import { Fragment, useState } from 'react';
import { Button } from '@components/core/Button';
import { Dropdown } from '@components/core/Dropdown';
import { Icon } from '@components/core/Icon';
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

  const selected = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';

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

  const relativeActive = isRelative(from) && (until === 'now' || !until);

  return (
    <div className="time-range-picker">
      <Button
        icon="history-alt"
        iconRight="angle-down"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        {formatRangeLabel(from, until, range)}
      </Button>
      <Dropdown open={open} onClose={() => setOpen(false)} className="trp">
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
