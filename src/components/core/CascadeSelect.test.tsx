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
