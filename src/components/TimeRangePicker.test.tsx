import { act, fireEvent, render, screen, within } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { TimeRangePicker } from './TimeRangePicker.tsx';
import { resolveRange } from '../time';

/** A promise this test decides when to settle — mirrors the helper in
 * useServices.test.ts / useProfileData.test.ts. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

const at = (search: string) => window.history.replaceState(null, '', search);

// The component takes the range App resolved; the tests resolve it the same
// way so the label and the drafted bounds match the from/until they pass.
const rangeOf = (from: string, until: string) =>
  resolveRange(from, until, Date.now());

const open = (from = 'now-1h', until = 'now') => {
  render(
    <TimeRangePicker from={from} until={until} range={rangeOf(from, until)} />,
  );
  const trigger = screen.getByRole('button', { name: /Last|:/ });
  fireEvent.click(trigger);
  return trigger;
};

const field = (label: string) =>
  within(screen.getByText(label).closest('label')!).getByRole(
    'textbox',
  ) as HTMLInputElement;

const params = () => new URLSearchParams(window.location.search);

beforeEach(() => at('/'));

describe('TimeRangePicker', () => {
  it('labels the trigger with the current range', () => {
    render(
      <TimeRangePicker
        from="now-6h"
        until="now"
        range={rangeOf('now-6h', 'now')}
      />,
    );
    assert.ok(screen.getByRole('button', { name: /Last 6h/ }));
  });

  it('opens and closes the panel from the trigger', () => {
    const trigger = open();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('Absolute range'));
    fireEvent.click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });

  it('writes a preset as a relative from, clearing until', () => {
    at('/?from=1000&until=2000');
    open();
    fireEvent.click(screen.getByText('Last 30 minutes'));
    assert.equal(params().get('from'), 'now-30m');
    assert.equal(params().has('until'), false);
  });

  it('marks the active preset', () => {
    open('now-6h', 'now');
    assert.ok(screen.getByText('Last 6 hours').classList.contains('active'));
    assert.ok(!screen.getByText('Last 1 hour').classList.contains('active'));
  });

  it('marks no preset while an absolute range is in force', () => {
    open('1786000000000', '1786003600000');
    for (const label of ['Last 1 hour', 'Last 6 hours']) {
      assert.ok(!screen.getByText(label).classList.contains('active'), label);
    }
  });

  it('fills the absolute form from the range in force', () => {
    const from = new Date(2026, 0, 2, 9, 5, 0).getTime();
    const until = new Date(2026, 0, 2, 17, 30, 0).getTime();
    open(String(from), String(until));
    assert.equal(field('From').value, '2026-01-02 09:05:00');
    assert.equal(field('To').value, '2026-01-02 17:30:00');
  });

  it('applies an absolute range as unix milliseconds', () => {
    open();
    fireEvent.change(field('From'), {
      target: { value: '2026-01-02 09:05:00' },
    });
    fireEvent.change(field('To'), { target: { value: '2026-01-02 17:30:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply time range' }));

    assert.equal(
      params().get('from'),
      String(new Date(2026, 0, 2, 9, 5, 0).getTime()),
    );
    assert.equal(
      params().get('until'),
      String(new Date(2026, 0, 2, 17, 30, 0).getTime()),
    );
  });

  it('applies on Enter from either field', () => {
    open();
    fireEvent.change(field('From'), {
      target: { value: '2026-01-02 09:05:00' },
    });
    fireEvent.change(field('To'), { target: { value: '2026-01-02 17:30:00' } });
    fireEvent.keyDown(field('To'), { key: 'Enter' });
    assert.ok(params().has('from'));
  });

  it('summarises how long the drafted range is', () => {
    open();
    fireEvent.change(field('From'), {
      target: { value: '2026-01-02 09:00:00' },
    });
    fireEvent.change(field('To'), { target: { value: '2026-01-02 11:30:00' } });
    assert.ok(screen.getByText('2h 30m range'));
  });

  it('refuses a range it cannot parse', () => {
    open();
    fireEvent.change(field('From'), { target: { value: 'yesterday' } });
    const apply = screen.getByRole('button', {
      name: 'Apply time range',
    }) as HTMLButtonElement;
    assert.equal(apply.disabled, true);
    assert.equal(field('From').getAttribute('aria-invalid'), 'true');
    assert.ok(screen.getByText(/YYYY-MM-DD HH:mm:ss/));

    fireEvent.click(apply);
    assert.equal(params().has('from'), false);
  });

  it('refuses a date that only looks valid', () => {
    // Date() happily rolls 25:00 over into the next day; the picker must not.
    open();
    for (const value of ['2026-13-02 09:00:00', '2026-01-02 25:00:00']) {
      fireEvent.change(field('From'), { target: { value } });
      assert.equal(field('From').getAttribute('aria-invalid'), 'true', value);
    }
  });

  it('refuses an end that is not after the start', () => {
    open();
    fireEvent.change(field('From'), {
      target: { value: '2026-01-02 17:30:00' },
    });
    fireEvent.change(field('To'), { target: { value: '2026-01-02 09:05:00' } });
    assert.ok(screen.getByText('End must be after start'));
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Apply time range',
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
  });

  it('redrafts from the URL every time it opens', () => {
    // The draft is an edit buffer: reopening must not show what was abandoned.
    const trigger = open('now-1h', 'now');
    fireEvent.change(field('From'), { target: { value: 'scribble' } });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    assert.match(field('From').value, /^\d{4}-\d{2}-\d{2} /);
  });

  it('picks a date from the calendar, keeping the time of day', () => {
    open(String(new Date(2026, 0, 2, 9, 5, 0).getTime()), 'now');
    fireEvent.click(screen.getByRole('button', { name: 'Pick from date' }));
    const calendar = screen.getByRole('dialog', { name: 'Choose date' });
    assert.ok(within(calendar).getByText('January 2026'));
    fireEvent.click(within(calendar).getByText('15'));
    assert.equal(field('From').value, '2026-01-15 09:05:00');
  });

  it('re-anchors an open draft when the URL range moves underneath it', () => {
    // Back/Forward while the picker is open must not let a stale draft
    // (from range A) clobber the range the URL has already moved to (B).
    const fromA = String(new Date(2026, 0, 2, 9, 5, 0).getTime());
    const untilA = String(new Date(2026, 0, 2, 17, 30, 0).getTime());
    const fromB = String(new Date(2026, 0, 5, 8, 0, 0).getTime());
    const untilB = String(new Date(2026, 0, 5, 12, 0, 0).getTime());

    const { rerender } = render(
      <TimeRangePicker
        from={fromA}
        until={untilA}
        range={rangeOf(fromA, untilA)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /:/ }));
    assert.equal(field('From').value, '2026-01-02 09:05:00');
    assert.equal(field('To').value, '2026-01-02 17:30:00');

    rerender(
      <TimeRangePicker
        from={fromB}
        until={untilB}
        range={rangeOf(fromB, untilB)}
      />,
    );
    assert.equal(field('From').value, '2026-01-05 08:00:00');
    assert.equal(field('To').value, '2026-01-05 12:00:00');

    fireEvent.click(screen.getByRole('button', { name: 'Apply time range' }));
    assert.equal(params().get('from'), fromB);
    assert.equal(params().get('until'), untilB);
  });

  it('re-anchors an open calendar when the URL range moves underneath it', () => {
    // Same scenario as the draft re-anchor test above, but for the popover's
    // own month/year view: Back/Forward must not leave the calendar showing
    // a stale month with no highlighted day.
    const fromA = String(new Date(2026, 0, 2, 9, 5, 0).getTime());
    const untilA = String(new Date(2026, 0, 2, 17, 30, 0).getTime());
    const fromB = String(new Date(2026, 5, 5, 8, 0, 0).getTime());
    const untilB = String(new Date(2026, 5, 5, 12, 0, 0).getTime());

    const { rerender } = render(
      <TimeRangePicker
        from={fromA}
        until={untilA}
        range={rangeOf(fromA, untilA)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick from date' }));
    const calendar = () => screen.getByRole('dialog', { name: 'Choose date' });
    assert.ok(within(calendar()).getByText('January 2026'));

    rerender(
      <TimeRangePicker
        from={fromB}
        until={untilB}
        range={rangeOf(fromB, untilB)}
      />,
    );
    assert.ok(within(calendar()).getByText('June 2026'));
  });

  it('does not re-anchor the calendar to a shape-valid but impossible date', () => {
    // Date() rolls month 13 over into next January; the calendar must not
    // follow it there (nor render "undefined" for MONTHS[12]).
    open(String(new Date(2026, 0, 2, 9, 5, 0).getTime()), 'now');
    fireEvent.click(screen.getByRole('button', { name: 'Pick from date' }));
    const calendar = () => screen.getByRole('dialog', { name: 'Choose date' });
    assert.ok(within(calendar()).getByText('January 2026'));

    fireEvent.change(field('From'), {
      target: { value: '2026-13-01 09:00:00' },
    });

    assert.ok(within(calendar()).getByText('January 2026'));
    assert.ok(!within(calendar()).queryByText(/undefined/));
  });

  it('walks the calendar month by month', () => {
    open(String(new Date(2026, 0, 2, 9, 5, 0).getTime()), 'now');
    fireEvent.click(screen.getByRole('button', { name: 'Pick from date' }));
    const calendar = () => screen.getByRole('dialog', { name: 'Choose date' });
    fireEvent.click(
      within(calendar()).getByRole('button', { name: 'Previous month' }),
    );
    assert.ok(within(calendar()).getByText('December 2025'));
    fireEvent.click(
      within(calendar()).getByRole('button', { name: 'Next month' }),
    );
    assert.ok(within(calendar()).getByText('January 2026'));
  });

  describe('the `y` shortcut', () => {
    it('switches a relative range to absolute', () => {
      at('/?from=now-1h');
      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);

      fireEvent.keyDown(window, { key: 'y' });

      assert.equal(params().get('from'), String(range.start));
      assert.equal(params().get('until'), String(range.end));
    });

    it('is ignored while a text field has focus', () => {
      const trigger = open();
      const from = field('From');
      from.focus();

      fireEvent.keyDown(from, { key: 'y' });

      assert.equal(params().has('from'), false);
      // The picker is still open and untouched — the keystroke did nothing.
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    });

    it('is ignored with a modifier key held, or as a different-case key event', () => {
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      fireEvent.keyDown(window, { key: 'Y', shiftKey: true });
      fireEvent.keyDown(window, { key: 'y', ctrlKey: true });

      // Untouched: the range must still read relative, not the absolute
      // bounds the shortcut would have written.
      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('the `t a` sequence switches a relative range to absolute', () => {
      at('/?from=now-1h');
      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'a' });

      assert.equal(params().get('from'), String(range.start));
      assert.equal(params().get('until'), String(range.end));
    });

    it('an unrelated key between `t` and `a` disarms the sequence', () => {
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'x' });
      fireEvent.keyDown(window, { key: 'a' });

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('a second unguarded `t` re-arms the sequence instead of cancelling it', () => {
      // Holding `t` (key-repeat) or literally retyping it should still lead
      // into `t a` — treating it as "any other key" would swallow the
      // sequence and require starting over.
      at('/?from=now-1h');
      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'a' });

      assert.equal(params().get('from'), String(range.start));
      assert.equal(params().get('until'), String(range.end));
    });

    it('`a` alone does nothing', () => {
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      fireEvent.keyDown(window, { key: 'a' });

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('a `t` pressed while a text field has focus does not arm the sequence', () => {
      const trigger = open();
      const from = field('From');
      from.focus();

      fireEvent.keyDown(from, { key: 't' });
      fireEvent.keyDown(window, { key: 'a' });

      assert.equal(params().has('from'), false);
      // The picker is still open and untouched — the keystrokes did nothing.
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    });
  });

  describe('the `t z` / `t ArrowLeft` / `t ArrowRight` shortcuts', () => {
    it('`t z` zooms out 2x, centered on the current range', () => {
      const from = String(new Date(2026, 0, 2, 9, 0, 0).getTime());
      const until = String(new Date(2026, 0, 2, 11, 0, 0).getTime());
      const range = rangeOf(from, until);
      render(<TimeRangePicker from={from} until={until} range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'z' });

      const half = (range.end - range.start) / 2;
      assert.equal(params().get('from'), String(range.start - half));
      assert.equal(params().get('until'), String(range.end + half));
    });

    it('`t ArrowLeft` shifts the window back by half its span', () => {
      const from = String(new Date(2026, 0, 2, 9, 0, 0).getTime());
      const until = String(new Date(2026, 0, 2, 11, 0, 0).getTime());
      const range = rangeOf(from, until);
      render(<TimeRangePicker from={from} until={until} range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'ArrowLeft' });

      const half = (range.end - range.start) / 2;
      assert.equal(params().get('from'), String(range.start - half));
      assert.equal(params().get('until'), String(range.end - half));
    });

    it('`t ArrowRight` shifts the window forward by half its span when it is far in the past', () => {
      const from = String(new Date(2026, 0, 2, 9, 0, 0).getTime());
      const until = String(new Date(2026, 0, 2, 11, 0, 0).getTime());
      const range = rangeOf(from, until);
      render(<TimeRangePicker from={from} until={until} range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      const half = (range.end - range.start) / 2;
      assert.equal(params().get('from'), String(range.start + half));
      assert.equal(params().get('until'), String(range.end + half));
    });

    it('`t ArrowRight` does nothing once the window already reaches "now"', () => {
      // end is a few seconds ahead of "now" at construction time — comfortably
      // still ahead of whatever Date.now() the handler reads at dispatch (a
      // few ms later), so the guard reliably sees range.end >= now without
      // racing the clock.
      const now = Date.now();
      const from = String(now - 3_600_000);
      const until = String(now + 5_000);
      const range = rangeOf(from, until);
      render(<TimeRangePicker from={from} until={until} range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      assert.equal(params().has('from'), false);
      assert.equal(params().has('until'), false);
    });

    it('`t ArrowRight` is a no-op for a relative range ending at "now"', () => {
      // range.end is a snapshot of "now" taken whenever `range` was last
      // resolved; the real clock keeps moving after that, so by the time the
      // handler's own Date.now() runs, range.end is already behind it and
      // the range.end>=now guard alone reads false. Guarding on the
      // committed `until` value first — "now" is never behind "now" — is
      // what has to keep this a no-op rather than converting the range to
      // absolute and shifting it by whatever few milliseconds elapsed.
      at('/?from=now-1h');
      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('`t ArrowRight` clamps to "now" instead of overshooting when the shift would pass it', () => {
      // The untested branch of shiftForward: `range.end` is in the past, but
      // `range.end + span/2` overshoots "now" — the result must clamp to
      // [now - span, now] rather than land past "now" or shrink the span.
      // This file has no Date mocking convention (see the rest of this
      // suite), so rather than pin an exact instant, this asserts the two
      // invariants the clamp promises: the span survives intact and the new
      // `until` lands within the window the real clock could have produced
      // between dispatch and this assertion.
      const span = 3_600_000; // 1h
      // A quarter-span into the past: still comfortably true that
      // `range.end + span/2 > now` (an eighth-span margin) without being so
      // close to "now" that a slow CI runner could flip the branch.
      const end = Date.now() - span / 4;
      const from = String(end - span);
      const until = String(end);
      const range = rangeOf(from, until);
      render(<TimeRangePicker from={from} until={until} range={range} />);

      const before = Date.now();
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      const after = Date.now();

      const newFrom = Number(params().get('from'));
      const newUntil = Number(params().get('until'));
      assert.ok(
        newUntil >= before && newUntil <= after,
        `until ${newUntil} outside [${before}, ${after}]`,
      );
      assert.equal(newUntil - newFrom, span);
    });
  });

  describe('the `t c` / `t v` shortcuts', () => {
    const originalClipboard = navigator.clipboard;

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('`t c` copies a relative range as Grafana-format JSON', async () => {
      at('/?from=now-1h');
      const calls: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            calls.push(text);
          },
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'c' });

      await screen.findByRole('button', { name: 'Copied' });

      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0]), { from: 'now-1h', to: 'now' });
    });

    it('`t c` copies an absolute range as ISO-8601 UTC, matching current Grafana', async () => {
      const from = new Date(2026, 0, 2, 9, 5, 0).getTime();
      const until = new Date(2026, 0, 2, 17, 30, 0).getTime();
      const calls: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            calls.push(text);
          },
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from={String(from)}
          until={String(until)}
          range={rangeOf(String(from), String(until))}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'c' });

      await screen.findByRole('button', { name: 'Copied' });

      assert.deepEqual(JSON.parse(calls[0]), {
        from: new Date(from).toISOString(),
        to: new Date(until).toISOString(),
      });
    });

    it('`t c` formats a mixed range per endpoint, not by `from` alone', async () => {
      // A relative `until` ("now") next to an absolute `from` — e.g. the
      // result of pasting `{"from":"<iso>","to":"now"}` — must keep the
      // relative side moving rather than freezing both as absolute.
      const from = String(new Date(2026, 0, 2, 9, 5, 0).getTime());
      const calls: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            calls.push(text);
          },
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from={from}
          until="now"
          range={rangeOf(from, 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'c' });

      await screen.findByRole('button', { name: 'Copied' });

      assert.deepEqual(JSON.parse(calls[0]), {
        from: new Date(Number(from)).toISOString(),
        to: 'now',
      });
    });

    it('`t v` pastes an absolute Grafana JSON range in the older local format', async () => {
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () =>
            JSON.stringify({
              from: '2026-01-02 09:05:00',
              to: '2026-01-02 17:30:00',
            }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.equal(
        params().get('from'),
        String(new Date(2026, 0, 2, 9, 5, 0).getTime()),
      );
      assert.equal(
        params().get('until'),
        String(new Date(2026, 0, 2, 17, 30, 0).getTime()),
      );
    });

    it('`t v` pastes an absolute Grafana JSON range in the current ISO-8601 format', async () => {
      const fromIso = '2026-01-02T09:05:00.000Z';
      const toIso = '2026-01-02T17:30:00.000Z';
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () => JSON.stringify({ from: fromIso, to: toIso }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Date.parse of the same ISO strings, not a hand-built local Date — the
      // whole point of ISO is that the instant does not depend on the
      // runner's timezone.
      assert.equal(params().get('from'), String(Date.parse(fromIso)));
      assert.equal(params().get('until'), String(Date.parse(toIso)));
    });

    it('rejects an ISO date that rolls over a calendar boundary, even though Date.parse would not', async () => {
      // V8's Date.parse('...-02-30...') returns March 2 rather than NaN — an
      // engine-dependent silent rollover `parseClipboardTimeValue` has to
      // catch itself, the same way `parseLocalInput` already does for the
      // local-format branch.
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () =>
            JSON.stringify({ from: '2026-02-30T00:00:00Z', to: 'now' }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      await screen.findByRole('button', { name: 'Paste failed' });
      assert.equal(params().get('from'), 'now-1h');
    });

    it('accepts a real leap-day ISO date', async () => {
      const fromIso = '2028-02-29T00:00:00Z';
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () => JSON.stringify({ from: fromIso, to: 'now' }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.equal(params().get('from'), String(Date.parse(fromIso)));
      assert.equal(params().has('until'), false);
    });

    it('rejects an absolute value that would be misread as unix seconds by resolveTime', async () => {
      // resolveTime() (src/time.ts) treats any URL number below 4_102_444_800
      // as seconds, not ms. This ISO instant (January 1970) is a real date
      // but its ms value falls under that threshold — accepting it would
      // write a `from` that resolves to a wrong date (year ~2022) the moment
      // the URL is read back, worse than rejecting it outright.
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () =>
            JSON.stringify({ from: '1970-01-20T00:00:00Z', to: 'now' }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      await screen.findByRole('button', { name: 'Paste failed' });
      assert.equal(params().get('from'), 'now-1h');
    });

    it('`t v` pastes a relative Grafana JSON range, clearing `until` for "now"', async () => {
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () => JSON.stringify({ from: 'now-6h', to: 'now' }),
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.equal(params().get('from'), 'now-6h');
      assert.equal(params().has('until'), false);
    });

    it('`t v` ignores clipboard content that does not parse as Grafana JSON', async () => {
      // Non-JSON, JSON missing a key, and JSON with a value that fits none of
      // the three accepted shapes — all untrusted, all a no-op.
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      for (const bad of [
        'not json',
        '{}',
        '{"from":"now-1h"}',
        '{"from":123,"to":"now"}',
        '{"from":"whenever","to":"now"}',
      ]) {
        Object.defineProperty(navigator, 'clipboard', {
          value: { readText: async () => bad },
          configurable: true,
          writable: true,
        });
        fireEvent.keyDown(window, { key: 't' });
        fireEvent.keyDown(window, { key: 'v' });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('`t v` rejects hostile magnitudes rather than treating them as valid', async () => {
      // A `now-`-prefixed value with an absurd digit count (`isRelative`'s
      // own regex has no length cap) and a numeric string long enough to
      // overflow a safe integer — both shape-valid to one branch of
      // `parseClipboardTimeValue`, neither a real timestamp.
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      for (const bad of [
        JSON.stringify({ from: 'now-99999999999999999999h', to: 'now' }),
        JSON.stringify({ from: '9'.repeat(300), to: 'now' }),
      ]) {
        Object.defineProperty(navigator, 'clipboard', {
          value: { readText: async () => bad },
          configurable: true,
          writable: true,
        });
        fireEvent.keyDown(window, { key: 't' });
        fireEvent.keyDown(window, { key: 'v' });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('accepts the documented parser-boundary shapes: 0/1/3 ISO fractional digits, `+`/`-` offsets, a 7-digit relative quantity', async () => {
      const cases: [string, () => string][] = [
        [
          '2026-01-02T09:05:00Z',
          () => String(Date.parse('2026-01-02T09:05:00Z')),
        ],
        [
          '2026-01-02T09:05:00.5Z',
          () => String(Date.parse('2026-01-02T09:05:00.5Z')),
        ],
        [
          '2026-01-02T09:05:00.500Z',
          () => String(Date.parse('2026-01-02T09:05:00.500Z')),
        ],
        [
          '2026-01-02T09:05:00+09:00',
          () => String(Date.parse('2026-01-02T09:05:00+09:00')),
        ],
        [
          '2026-01-02T09:05:00-05:00',
          () => String(Date.parse('2026-01-02T09:05:00-05:00')),
        ],
        ['now-9999999h', () => 'now-9999999h'],
      ];

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      for (const [value, expected] of cases) {
        at('/?from=now-1h');
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            readText: async () => JSON.stringify({ from: value, to: 'now' }),
          },
          configurable: true,
          writable: true,
        });
        fireEvent.keyDown(window, { key: 't' });
        fireEvent.keyDown(window, { key: 'v' });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        assert.equal(params().get('from'), expected(), value);
      }
    });

    it('rejects the documented parser-boundary shapes: lowercase `z`, an 8-digit relative quantity', async () => {
      // Lowercase `z` fails the ISO branch (the regex requires the literal
      // capital) and also fails the local-format branch — unlike a genuinely
      // zoneless string, it doesn't fall back to being read as local time, it
      // is simply not a shape either branch accepts. The 8-digit relative
      // quantity is one digit past the accepted-case above.
      at('/?from=now-1h');
      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      for (const bad of [
        JSON.stringify({ from: '2026-01-02T09:05:00z', to: 'now' }),
        JSON.stringify({ from: 'now-99999999h', to: 'now' }),
      ]) {
        Object.defineProperty(navigator, 'clipboard', {
          value: { readText: async () => bad },
          configurable: true,
          writable: true,
        });
        fireEvent.keyDown(window, { key: 't' });
        fireEvent.keyDown(window, { key: 'v' });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('a stale `t v` is discarded once a real navigation changes the URL', async () => {
      // A preset click / Back / Forward changes the URL itself — the one
      // thing pasteRange's dispatch-time URL capture treats as a real
      // navigation, as opposed to an auto-refresh tick (see the test below),
      // which rerenders with a fresh `range` object but leaves the URL
      // untouched. readText() settling after this must not silently
      // override whatever the URL moved to since.
      at('/?from=now-1h');
      const read = deferred<string>();
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: () => read.promise },
        configurable: true,
        writable: true,
      });

      const { rerender } = render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      at('/?from=now-6h');
      rerender(
        <TimeRangePicker
          from="now-6h"
          until="now"
          range={rangeOf('now-6h', 'now')}
        />,
      );

      await act(async () => {
        read.settle(
          JSON.stringify({
            from: '2026-01-02 09:05:00',
            to: '2026-01-02 17:30:00',
          }),
        );
        await read.promise;
      });

      // Untouched since the real navigation: the stale paste must not have
      // navigated on top of it.
      assert.equal(params().get('from'), 'now-6h');
      assert.equal(params().has('until'), false);
    });

    it('a `t v` still navigates after an auto-refresh tick that leaves the URL unchanged', async () => {
      // Auto-refresh calls navigate({ set: {} }) every tick: the URL stays
      // byte-identical but the frozen "now" advances, so `range` is a new
      // object each time — simulated here by rerendering with a fresh
      // `rangeOf(...)` call (its values may differ from the first by a few
      // ms, matching a real tick). Old code treated that the same as a real
      // navigation (the keydown effect re-registered on `range`, bumping
      // pasteGeneration in its cleanup) and silently dropped this paste even
      // though the URL never moved. It must still land.
      at('/?from=now-1h');
      const read = deferred<string>();
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: () => read.promise },
        configurable: true,
        writable: true,
      });

      const { rerender } = render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      rerender(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      await act(async () => {
        read.settle(
          JSON.stringify({
            from: '2026-01-02 09:05:00',
            to: '2026-01-02 17:30:00',
          }),
        );
        await read.promise;
      });

      assert.equal(
        params().get('from'),
        String(new Date(2026, 0, 2, 9, 5, 0).getTime()),
      );
      assert.equal(
        params().get('until'),
        String(new Date(2026, 0, 2, 17, 30, 0).getTime()),
      );
    });

    it('a `t v` still navigates after a replace-navigation that changes only fgSearch', async () => {
      // The flame graph search's own 400ms debounce lands as a
      // replace-navigation while readText() can still be in flight — it
      // writes fgSearch only, so the pathname and the from/until params this
      // paste is about to overwrite never moved. Old code compared the
      // WHOLE pathname+search at dispatch against settlement, so this
      // fgSearch-only change looked exactly like the real-navigation case
      // above and silently discarded the paste, with no feedback.
      at('/?from=now-1h');
      const read = deferred<string>();
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: () => read.promise },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      // Simulates the fgSearch debounce's own replace-navigation landing
      // before this paste's clipboard read has settled.
      at('/?from=now-1h&fgSearch=alloc');

      await act(async () => {
        read.settle(
          JSON.stringify({
            from: '2026-01-02 09:05:00',
            to: '2026-01-02 17:30:00',
          }),
        );
        await read.promise;
      });

      assert.equal(
        params().get('from'),
        String(new Date(2026, 0, 2, 9, 5, 0).getTime()),
      );
      assert.equal(
        params().get('until'),
        String(new Date(2026, 0, 2, 17, 30, 0).getTime()),
      );
    });

    it('`t`, then an auto-refresh tick, then `c` still copies the range', async () => {
      // Old code re-registered the keydown effect on every `range` change,
      // and its cleanup unconditionally disarmed the pending `t` — a tick
      // landing between `t` and `c` silently killed the sequence, with no
      // feedback. Registering the effect once (reading range/from/until
      // through a ref instead) means a tick no longer touches `tPending` at
      // all, so the sequence the user is still typing survives it.
      at('/?from=now-1h');
      const calls: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            calls.push(text);
          },
        },
        configurable: true,
        writable: true,
      });

      const { rerender } = render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });

      // Simulated tick: a fresh `range` object, same from/until, URL
      // untouched.
      rerender(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      fireEvent.keyDown(window, { key: 'c' });

      await screen.findByRole('button', { name: 'Copied' });
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0]), { from: 'now-1h', to: 'now' });
    });

    it('shows "Paste failed" for an unparseable clipboard, without navigating', async () => {
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: async () => 'not json' },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      await screen.findByRole('button', { name: 'Paste failed' });

      assert.equal(params().get('from'), 'now-1h');
      assert.equal(params().has('until'), false);
    });

    it('shows "Paste failed" when the clipboard cannot be read at all (no secure context)', async () => {
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {},
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      await screen.findByRole('button', { name: 'Paste failed' });
      assert.equal(params().get('from'), 'now-1h');
    });

    it('shows "Paste failed" when readText rejects (e.g. permission denied)', async () => {
      at('/?from=now-1h');
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () => {
            throw new Error('denied');
          },
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );
      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      await screen.findByRole('button', { name: 'Paste failed' });
      assert.equal(params().get('from'), 'now-1h');
    });

    it('a stale `t v` failure cannot overwrite newer "Copied" feedback from `t c`', async () => {
      // `t v` starts (its readText is left pending), then `t c` completes
      // and shows "Copied" — only after that does the stale paste settle
      // with garbage. The failure has to lose: it started first, but it
      // resolved after a newer, truthful message already landed.
      at('/?from=now-1h');
      const read = deferred<string>();
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: () => read.promise,
          writeText: async () => {},
        },
        configurable: true,
        writable: true,
      });

      render(
        <TimeRangePicker
          from="now-1h"
          until="now"
          range={rangeOf('now-1h', 'now')}
        />,
      );

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'v' });

      fireEvent.keyDown(window, { key: 't' });
      fireEvent.keyDown(window, { key: 'c' });
      await screen.findByRole('button', { name: 'Copied' });

      await act(async () => {
        read.settle('not json');
        await read.promise;
      });

      assert.ok(screen.getByRole('button', { name: 'Copied' }));
      assert.equal(params().get('from'), 'now-1h');
    });

    it('a guarded `t` arms neither `t c` nor `t v`', () => {
      const trigger = open();
      const from = field('From');
      from.focus();

      fireEvent.keyDown(from, { key: 't' });
      fireEvent.keyDown(window, { key: 'c' });
      fireEvent.keyDown(window, { key: 'v' });

      assert.equal(params().has('from'), false);
      // The picker is still open and untouched — the keystrokes did nothing.
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    });
  });

  describe('copy absolute link', () => {
    const originalClipboard = navigator.clipboard;

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('copies the resolved bounds into the URL without navigating', async () => {
      // An unrelated param proves it is preserved rather than the URL being
      // rebuilt from scratch, and `from=now-1h` proves this screen's own URL
      // stays relative — only the copied text gets absolute bounds baked in.
      at('/?from=now-1h&query=%7Bfoo%7D');
      const calls: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            calls.push(text);
          },
        },
        configurable: true,
        writable: true,
      });

      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);
      fireEvent.click(screen.getByRole('button', { name: /Last/ }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Copy absolute link' }),
      );

      await screen.findByRole('button', { name: 'Copied' });

      assert.equal(calls.length, 1);
      const copied = new URL(calls[0]);
      assert.equal(copied.searchParams.get('from'), String(range.start));
      assert.equal(copied.searchParams.get('until'), String(range.end));
      assert.equal(copied.searchParams.get('query'), '{foo}');
      assert.match(window.location.search, /from=now-1h/);
    });

    it('a stale attempt cannot overwrite the status of the current one', async () => {
      // Two clicks in a row: the first click's writeText is still pending
      // when the second fires, so the first is stale by the time either
      // settles. Settling the current (second) attempt first and the stale
      // (first) one after — with opposite outcomes — proves the stale one
      // is ignored rather than winning the race by resolving last.
      at('/?from=now-1h');
      const attempts = [deferred<void>(), deferred<void>()];
      let call = 0;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => attempts[call++].promise },
        configurable: true,
        writable: true,
      });

      const range = rangeOf('now-1h', 'now');
      render(<TimeRangePicker from="now-1h" until="now" range={range} />);
      fireEvent.click(screen.getByRole('button', { name: /Last/ }));
      const copyButton = () =>
        screen.getByRole('button', {
          name: /Copy absolute link|Copied|Copy failed/,
        });

      fireEvent.click(copyButton()); // attempt 1: stale once attempt 2 fires
      fireEvent.click(copyButton()); // attempt 2: the current one

      await act(async () => {
        attempts[1].settle();
        await attempts[1].promise;
      });
      await screen.findByRole('button', { name: 'Copied' });

      // jsdom has no execCommand, so a rejected writeText's fallback
      // resolves false — a real failure for attempt 1, but attempt 1 is no
      // longer current and must not un-copy attempt 2's result.
      await act(async () => {
        attempts[0].fail(new Error('denied'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.ok(screen.getByRole('button', { name: 'Copied' }));
    });
  });
});
