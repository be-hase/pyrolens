import { fireEvent, render, screen, within } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { CascadeSelect, type CascadeGroup } from './CascadeSelect.tsx';

const GROUPS: CascadeGroup[] = [
  {
    label: 'checkout-service',
    value: 'checkout-service',
    items: [
      { label: 'cpu', value: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds' },
      { label: 'alloc_space', value: 'memory:alloc_space:bytes:space:bytes' },
    ],
  },
  {
    label: 'billing-service',
    value: 'billing-service',
    items: [
      { label: 'cpu', value: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds' },
    ],
  },
  { label: 'quiet-service', value: 'quiet-service', items: [] },
];

const CPU = GROUPS[0].items[0].value;

function setup({
  groups = GROUPS,
  value = { group: '', item: '' },
  loading = false,
}: {
  groups?: CascadeGroup[];
  value?: { group: string; item: string };
  loading?: boolean;
} = {}) {
  const onChange = vi.fn();
  render(
    <CascadeSelect
      groups={groups}
      groupLabel="Service"
      itemLabel="Profile Type"
      value={value}
      onChange={onChange}
      loading={loading}
    />,
  );
  return { onChange, trigger: screen.getByRole('button') };
}

/** The two popup columns, in order: groups on the left, items on the right. */
const columns = () => {
  const cols = document.querySelectorAll<HTMLElement>('.cascade-col');
  assert.equal(cols.length, 2, 'the popup is not open');
  return { groups: within(cols[0]), items: within(cols[1]) };
};

describe('CascadeSelect trigger', () => {
  it('asks for a selection when there is none', () => {
    const { trigger } = setup();
    assert.match(trigger.textContent ?? '', /Select service/);
  });

  it('shows both levels once both are chosen', () => {
    const { trigger } = setup({
      value: { group: 'checkout-service', item: CPU },
    });
    assert.match(trigger.textContent ?? '', /checkout-service · cpu/);
  });

  it('shows just the group when the item is not one of its own', () => {
    // The URL can name a profile type this service does not expose.
    const { trigger } = setup({
      value: { group: 'checkout-service', item: 'nonsense:x:y:z:w' },
    });
    assert.match(trigger.textContent ?? '', /checkout-service/);
    assert.doesNotMatch(trigger.textContent ?? '', /·/);
  });

  it('says it is loading rather than asking for a selection', () => {
    const { trigger } = setup({ groups: [], loading: true });
    assert.match(trigger.textContent ?? '', /Loading/);
  });

  it('describes the popup it controls', () => {
    const { trigger } = setup();
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    fireEvent.click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  });
});

describe('CascadeSelect browsing', () => {
  it('lists the groups and waits for one to be picked', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const { groups, items } = columns();
    for (const group of GROUPS) {
      assert.ok(groups.getByText(group.label), group.label);
    }
    assert.ok(items.getByText('Select service'));
  });

  it('shows a group’s items when it is browsed', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('checkout-service'));
    const { items } = columns();
    assert.ok(items.getByText('cpu'));
    assert.ok(items.getByText('alloc_space'));
  });

  it('browsing a group does not select it', () => {
    // The left column is navigation; only an item commits.
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('billing-service'));
    assert.equal(onChange.mock.calls.length, 0);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  });

  it('opens on the current selection', () => {
    const { trigger } = setup({
      value: { group: 'billing-service', item: CPU },
    });
    fireEvent.click(trigger);
    assert.ok(
      columns()
        .groups.getByText('billing-service')
        .closest('button')
        ?.className.includes('active'),
    );
  });

  it('forgets what was browsed the next time it opens', () => {
    // Reopening after browsing elsewhere must show the selection again, not
    // wherever the pointer wandered last time.
    const { trigger } = setup({
      value: { group: 'billing-service', item: CPU },
    });
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('checkout-service'));
    assert.ok(columns().items.queryByText('alloc_space'));

    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // reopen
    assert.ok(!columns().items.queryByText('alloc_space'));
    assert.ok(
      columns()
        .groups.getByText('billing-service')
        .closest('button')
        ?.className.includes('active'),
    );
  });

  it('says so when a group has nothing to offer', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('quiet-service'));
    assert.ok(columns().items.getByText('No results'));
  });

  it('says so when there are no groups at all', () => {
    const { trigger } = setup({ groups: [] });
    fireEvent.click(trigger);
    assert.ok(columns().groups.getByText('No results'));
  });

  it('says it is still loading rather than claiming there is nothing', () => {
    const { trigger } = setup({ groups: [], loading: true });
    fireEvent.click(trigger);
    assert.ok(columns().groups.getByText('Loading…'));
  });
});

describe('CascadeSelect selection', () => {
  it('reports both levels and closes', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('checkout-service'));
    fireEvent.click(columns().items.getByText('alloc_space'));

    assert.deepEqual(onChange.mock.calls, [
      ['checkout-service', 'memory:alloc_space:bytes:space:bytes'],
    ]);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });

  it('reports the group being browsed, not the one selected', () => {
    // Switching service and profile type in one go is the whole point of the
    // second column; reporting the old group would query the wrong service.
    const { trigger, onChange } = setup({
      value: { group: 'checkout-service', item: CPU },
    });
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('billing-service'));
    fireEvent.click(columns().items.getByText('cpu'));
    assert.deepEqual(onChange.mock.calls, [['billing-service', CPU]]);
  });

  it('marks the selected item only under its own group', () => {
    // Both services expose a profile type with this exact value.
    const { trigger } = setup({
      value: { group: 'checkout-service', item: CPU },
    });
    fireEvent.click(trigger);
    assert.ok(
      columns()
        .items.getByText('cpu')
        .closest('button')
        ?.className.includes('active'),
    );

    fireEvent.click(columns().groups.getByText('billing-service'));
    assert.ok(
      !columns()
        .items.getByText('cpu')
        .closest('button')
        ?.className.includes('active'),
    );
  });

  it('closes on Escape without reporting anything', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(onChange.mock.calls.length, 0);
  });
});

describe('CascadeSelect filter', () => {
  it('narrows the visible services as the filter is typed', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const { groups } = columns();
    fireEvent.change(groups.getByPlaceholderText(/Filter/), {
      target: { value: 'checkout' },
    });
    assert.ok(columns().groups.getByText('checkout-service'));
    assert.ok(!columns().groups.queryByText('billing-service'));
    assert.ok(!columns().groups.queryByText('quiet-service'));
  });

  it('restores every service once the filter is cleared', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const filterInput = columns().groups.getByPlaceholderText(/Filter/);
    fireEvent.change(filterInput, { target: { value: 'checkout' } });
    fireEvent.change(filterInput, { target: { value: '' } });
    const { groups } = columns();
    for (const group of GROUPS) {
      assert.ok(groups.getByText(group.label), group.label);
    }
  });

  it('fuzzy-matches a non-prefix substring', () => {
    // "out" is nowhere near the start of "checkout-service"; a prefix-only
    // filter would drop it.
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.change(columns().groups.getByPlaceholderText(/Filter/), {
      target: { value: 'out' },
    });
    assert.ok(columns().groups.getByText('checkout-service'));
  });

  it('selects the highlighted service on ArrowDown then Enter', () => {
    // Two steps down from GROUPS[0] (checkout-service) lands on GROUPS[1]
    // (billing-service) — an Enter that always took index 0 regardless of
    // how many times ArrowDown fired would still show checkout-service's
    // items and pass a single-ArrowDown version of this test.
    const { trigger } = setup();
    fireEvent.click(trigger);
    const filterInput = columns().groups.getByPlaceholderText(/Filter/);
    fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
    fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    const { items } = columns();
    assert.ok(items.getByText('cpu'));
    assert.ok(!items.queryByText('alloc_space'));
  });

  it('ArrowUp with nothing highlighted starts from the last service, not the second-to-last', () => {
    // `(-1 - 1 + N) % N` is N-2, which would land on billing-service
    // (GROUPS[1]) instead of the actual last row, quiet-service (GROUPS[2]).
    // quiet-service has no items, so landing anywhere else would show `cpu`
    // instead of the empty state.
    const { trigger } = setup();
    fireEvent.click(trigger);
    const filterInput = columns().groups.getByPlaceholderText(/Filter/);
    fireEvent.keyDown(filterInput, { key: 'ArrowUp' });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    const { items } = columns();
    assert.ok(items.getByText('No results'));
  });

  it('a filter that excludes the browsed service hides its items and blocks selecting it', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(columns().groups.getByText('checkout-service'));
    assert.ok(columns().items.getByText('alloc_space'));

    fireEvent.change(columns().groups.getByPlaceholderText(/Filter/), {
      target: { value: 'billing' },
    });
    const { groups, items } = columns();
    assert.ok(!groups.queryByText('checkout-service'));
    assert.ok(!items.queryByText('alloc_space'));
    assert.ok(!items.queryByText('cpu'));
    assert.equal(onChange.mock.calls.length, 0);
  });

  it('selects a filter narrowed to exactly one match on Enter alone', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const filterInput = columns().groups.getByPlaceholderText(/Filter/);
    fireEvent.change(filterInput, { target: { value: 'billing' } });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    const { items } = columns();
    assert.ok(items.getByText('cpu'));
  });

  it('shows an empty filter again the next time it opens', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.change(columns().groups.getByPlaceholderText(/Filter/), {
      target: { value: 'checkout' },
    });

    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // reopen
    assert.equal(
      (columns().groups.getByPlaceholderText(/Filter/) as HTMLInputElement)
        .value,
      '',
    );
    assert.ok(columns().groups.getByText('billing-service'));
  });
});
