import { fireEvent, render, screen, within } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';
import { TimeRangePicker } from './TimeRangePicker.tsx';

const at = (search: string) => window.history.replaceState(null, '', search);

const open = (from = 'now-1h', until = 'now') => {
  render(<TimeRangePicker from={from} until={until} />);
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
    render(<TimeRangePicker from="now-6h" until="now" />);
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
});
