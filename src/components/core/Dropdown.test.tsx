import { fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { describe, it, vi } from 'vitest';
import { Dropdown } from './Dropdown.tsx';

/** A trigger and its panel inside the same anchor, the way callers use it. */
function Menu({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)}>{label}</button>
      <Dropdown
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      >
        {children ?? <button>{`${label} item`}</button>}
      </Dropdown>
    </div>
  );
}

describe('Dropdown', () => {
  it('renders nothing until it is opened', () => {
    render(<Menu label="Menu" />);
    assert.ok(!screen.queryByText('Menu item'));
    fireEvent.click(screen.getByText('Menu'));
    assert.ok(screen.getByText('Menu item'));
  });

  it('closes on a pointer-down outside the anchor', () => {
    render(
      <>
        <Menu label="Menu" />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByText('Menu'));
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    assert.ok(!screen.queryByText('Menu item'));
  });

  it('ignores a pointer-down on its own contents', () => {
    render(<Menu label="Menu" />);
    fireEvent.click(screen.getByText('Menu'));
    fireEvent.mouseDown(screen.getByText('Menu item'));
    assert.ok(screen.getByText('Menu item'));
  });

  it('ignores a pointer-down on the trigger, which toggles by itself', () => {
    // The trigger counts as inside, so its own onClick can close the panel
    // without racing this handler and reopening it.
    render(<Menu label="Menu" />);
    const trigger = screen.getByText('Menu');
    fireEvent.click(trigger);
    fireEvent.mouseDown(trigger);
    assert.ok(screen.getByText('Menu item'));
    fireEvent.click(trigger);
    assert.ok(!screen.queryByText('Menu item'));
  });

  it('closes on Escape', () => {
    render(<Menu label="Menu" />);
    fireEvent.click(screen.getByText('Menu'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!screen.queryByText('Menu item'));
  });

  it('lets Escape close only the innermost panel', () => {
    // The calendar inside the time range picker must not take the picker
    // down with it.
    const outerClosed = vi.fn();
    render(
      <Menu label="Outer" onClose={outerClosed}>
        <Menu label="Inner" />
      </Menu>,
    );
    fireEvent.click(screen.getByText('Outer'));
    fireEvent.click(screen.getByText('Inner'));
    assert.ok(screen.getByText('Inner item'));

    fireEvent.keyDown(document, { key: 'Escape' });
    assert.ok(!screen.queryByText('Inner item'));
    assert.equal(outerClosed.mock.calls.length, 0);
    assert.ok(screen.getByText('Inner'));

    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(outerClosed.mock.calls.length, 1);
  });

  it('stops listening once it is closed', () => {
    render(<Menu label="Menu" />);
    const trigger = screen.getByText('Menu');
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    // A leaked document listener would keep calling onClose from here on.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    assert.ok(!screen.queryByText('Menu item'));
  });

  it('takes an alignment class so it can open leftwards', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}>
        <Dropdown open onClose={() => {}} align="right" className="extra">
          <span>panel</span>
        </Dropdown>
      </div>,
    );
    const panel = container.querySelector('.dropdown');
    assert.ok(panel?.classList.contains('dropdown-right'));
    assert.ok(panel?.classList.contains('extra'));
  });
});
