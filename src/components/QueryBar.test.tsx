import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { beforeEach, describe, it, vi } from 'vitest';
import { fetchLabelNames, fetchLabelValues } from '@api/client';
import { QueryBar } from './QueryBar.tsx';

vi.mock('@api/client', () => ({
  fetchLabelNames: vi.fn(),
  fetchLabelValues: vi.fn(),
}));

const namesOf = vi.mocked(fetchLabelNames);
const valuesOf = vi.mocked(fetchLabelValues);

beforeEach(() => {
  namesOf.mockResolvedValue(['region', 'pod']);
  valuesOf.mockResolvedValue(['eu-west', 'us-east']);
});

// The bar is controlled: the view owns the query and feeds it back. Tests
// that type need that loop, or the caret context never sees the new text.
function setup(initial = '', opts: { loading?: boolean } = {}) {
  const onRun = vi.fn();
  const changes: string[] = [];
  function Host() {
    const [query, setQuery] = useState(initial);
    return (
      <QueryBar
        query={query}
        onQueryChange={(next) => {
          changes.push(next);
          setQuery(next);
        }}
        onRun={onRun}
        start={1_000}
        end={2_000}
        loading={opts.loading}
      />
    );
  }
  render(<Host />);
  return { onRun, changes };
}

const input = () => screen.getByRole('combobox') as HTMLInputElement;
const runButton = () => screen.getByRole('button', { name: /Run/ });
const listbox = () => screen.queryByRole('listbox');
const options = () => within(listbox()!).getAllByRole('option');

/** A keystroke, caret included — the popup keys off where the caret is. */
const type = (value: string) =>
  fireEvent.change(input(), {
    target: { value, selectionStart: value.length },
  });

const settle = () => act(async () => {});

describe('QueryBar', () => {
  it('shows the query it was given', () => {
    setup('{a="b"}');
    assert.equal(input().value, '{a="b"}');
  });

  it('reports every keystroke without running anything', () => {
    const { onRun, changes } = setup();
    type('{');
    assert.deepEqual(changes, ['{']);
    assert.equal(onRun.mock.calls.length, 0);
  });

  it('runs the query on the button', () => {
    const { onRun } = setup('{a="b"}');
    fireEvent.click(runButton());
    assert.deepEqual(onRun.mock.calls, [['{a="b"}']]);
  });

  it('runs the query on Enter when no suggestion is offered', () => {
    const { onRun } = setup('{a="b"}');
    fireEvent.keyDown(input(), { key: 'Enter' });
    assert.deepEqual(onRun.mock.calls, [['{a="b"}']]);
  });

  it('disables Run while a query is in flight', () => {
    setup('{a="b"}', { loading: true });
    assert.equal((runButton() as HTMLButtonElement).disabled, true);
    assert.equal(runButton().getAttribute('aria-busy'), 'true');
  });

  it('asks for nothing until the field is being edited', async () => {
    setup('{');
    await settle();
    assert.equal(listbox(), null);
    assert.equal(input().getAttribute('aria-expanded'), 'false');
    assert.equal(namesOf.mock.calls.length, 0);
  });

  it('offers label names once the caret is inside the selector', async () => {
    setup();
    type('{');
    await settle();
    assert.deepEqual(
      options().map((o) => o.textContent),
      ['region', 'pod'],
    );
    assert.equal(input().getAttribute('aria-expanded'), 'true');
  });

  it('offers label values after an operator', async () => {
    setup();
    type('{region="');
    // The label being completed is debounced before its values are fetched.
    await waitFor(() => assert.ok(listbox()));
    assert.deepEqual(
      options().map((o) => o.textContent),
      ['eu-west', 'us-east'],
    );
    assert.equal(valuesOf.mock.calls[0][0], 'region');
  });

  it('points aria-activedescendant at the highlighted option', async () => {
    setup();
    type('{');
    await settle();
    const [first, second] = options();
    assert.equal(input().getAttribute('aria-activedescendant'), first.id);
    assert.equal(first.getAttribute('aria-selected'), 'true');

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    assert.equal(input().getAttribute('aria-activedescendant'), second.id);
    assert.equal(second.getAttribute('aria-selected'), 'true');
  });

  it('wraps around the list with the arrow keys', async () => {
    setup();
    type('{');
    await settle();
    const [first, second] = options();
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    assert.equal(input().getAttribute('aria-activedescendant'), second.id);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    assert.equal(input().getAttribute('aria-activedescendant'), first.id);
  });

  it('accepts the highlighted suggestion on Enter instead of running', async () => {
    const { onRun } = setup();
    type('{');
    await settle();
    fireEvent.keyDown(input(), { key: 'Enter' });
    assert.equal(input().value, '{region=""');
    assert.equal(onRun.mock.calls.length, 0);
  });

  it('accepts a suggestion on mousedown, before the input can blur', async () => {
    // On click the input would have blurred first, closing the popup and
    // taking the item away before it could be picked.
    setup();
    type('{');
    await settle();
    fireEvent.mouseDown(within(listbox()!).getByText('pod'));
    assert.equal(input().value, '{pod=""');
  });

  it('highlights the option under the pointer', async () => {
    setup();
    type('{');
    await settle();
    const [, second] = options();
    fireEvent.mouseMove(second);
    assert.equal(input().getAttribute('aria-activedescendant'), second.id);
  });

  it('closes the popup on Escape without touching the query', async () => {
    const { changes } = setup();
    type('{');
    await settle();
    assert.ok(listbox());
    fireEvent.keyDown(input(), { key: 'Escape' });
    assert.equal(listbox(), null);
    assert.deepEqual(changes, ['{']);
  });

  it('closes the popup on blur', async () => {
    setup();
    type('{');
    await settle();
    fireEvent.blur(input());
    assert.equal(listbox(), null);
  });

  it('closes the popup when the query is run', async () => {
    setup();
    type('{');
    await settle();
    fireEvent.click(runButton());
    assert.equal(listbox(), null);
  });

  it('offers nothing once the selector is closed behind the caret', async () => {
    setup();
    type('{a="b"} ');
    await settle();
    assert.equal(listbox(), null);
  });

  it('leaves the arrow keys alone while the popup is closed', () => {
    // The caret still has to move; swallowing the key would pin it in place.
    setup('{a="b"}');
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  });
});
