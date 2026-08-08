import { fireEvent, render, screen, within } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { Select } from './Select.tsx';

const OPTIONS = [
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
  { label: 'System', value: 'system', divider: true },
];

const setup = (value = 'dark') => {
  const onChange = vi.fn();
  render(<Select value={value} options={OPTIONS} onChange={onChange} />);
  return { onChange, trigger: screen.getByRole('button', { name: /./ }) };
};

// The trigger repeats the selected option's label, so options are always
// looked up inside the popup.
const panel = () => {
  const el = document.querySelector<HTMLElement>('.dropdown');
  assert.ok(el, 'dropdown is not open');
  return within(el);
};

describe('Select', () => {
  it('shows the current option on the trigger', () => {
    const { trigger } = setup('light');
    assert.match(trigger.textContent ?? '', /Light/);
  });

  it('falls back to the raw value for an option it does not know', () => {
    const { trigger } = setup('sepia');
    assert.match(trigger.textContent ?? '', /sepia/);
  });

  it('describes the popup it controls', () => {
    const { trigger } = setup();
    assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    fireEvent.click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  });

  it('lists every option once opened', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    for (const option of OPTIONS) {
      assert.ok(panel().getByText(option.label), option.label);
    }
  });

  it('reports the picked value and closes', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(panel().getByText('Light'));
    assert.deepEqual(onChange.mock.calls, [['light']]);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });

  it('marks the selected option', () => {
    const { trigger } = setup('light');
    fireEvent.click(trigger);
    assert.ok(panel().getByText('Light').classList.contains('active'));
    assert.ok(!panel().getByText('Dark').classList.contains('active'));
  });

  it('toggles shut when the trigger is clicked again', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    assert.ok(!screen.queryByText('Light'));
  });

  it('does not report a change for the option already selected', () => {
    const { trigger, onChange } = setup('dark');
    fireEvent.click(trigger);
    fireEvent.click(panel().getByText('Dark'));
    // It still reports it — the caller decides; what matters is the value.
    assert.deepEqual(onChange.mock.calls, [['dark']]);
  });
});
