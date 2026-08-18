import { useEffect, useRef } from 'react';
import './Slider.css';

// A native <input type="range"> wrapped just enough to separate two events
// callers routinely need to tell apart: React's onInput fires on every tick
// while dragging (a live draft), while onCommit only fires on the native
// `change` event — release, or a keyboard step landing — which is why it is
// wired with a raw listener rather than React's onChange prop. React
// normalizes onChange to the `input` event for range inputs (same as text
// inputs), so there is no React prop that means "only on commit"; the
// callback ref below is the only way to reach the real `change` event.
//
// Dumb on purpose: it knows nothing about presets or URL params. Callers
// (MaxNodesControl) own the value <-> label mapping and what committing
// means.
export function Slider({
  min,
  max,
  step = 1,
  value,
  label,
  valueText,
  onInput,
  onCommit,
}: {
  min: number;
  max: number;
  step?: number;
  /** Current position, already resolved (draft while dragging, committed
   * otherwise) — this component holds no state of its own. */
  value: number;
  /** Accessible name; the visible label is the caller's `valueText` slot. */
  label: string;
  /** Read out by assistive tech in place of the raw numeric value, and
   * shown next to the track. */
  valueText: string;
  /** Fires on every native `input` event (each tick while dragging). */
  onInput: (value: number) => void;
  /** Fires only on the native `change` event (release, or one keyboard
   * step). Registered once via a ref so a caller passing a fresh closure
   * every render does not re-subscribe on each keystroke of the draft. */
  onCommit: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Refs are read/written outside render only — see TimeRangePicker.tsx's
  // identical stateRef pattern. A no-deps effect keeps this current after
  // every render without making the listener-registering effect below
  // re-subscribe on every keystroke of a caller-supplied inline closure.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  });

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleChange = () => onCommitRef.current(Number(el.value));
    el.addEventListener('change', handleChange);
    return () => el.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="slider">
      <input
        ref={inputRef}
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={valueText}
        onInput={(e) => onInput(Number(e.currentTarget.value))}
      />
      <span className="slider-value" aria-hidden="true">
        {valueText}
      </span>
    </div>
  );
}
