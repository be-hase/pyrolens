import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { TenantDialog } from './TenantDialog.tsx';

const setup = (initial?: string) => {
  const onSubmit = vi.fn();
  render(<TenantDialog initial={initial} onSubmit={onSubmit} />);
  return {
    onSubmit,
    user: userEvent.setup(),
    input: screen.getByRole('textbox'),
    submit: screen.getByRole('button', { name: 'Submit' }),
  };
};

describe('TenantDialog', () => {
  it('announces itself as a modal dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-label'), 'Enter a Tenant ID');
  });

  it('starts from the remembered tenant and focuses the field', () => {
    const { input } = setup('team-a');
    assert.equal((input as HTMLInputElement).value, 'team-a');
    // assert.ok, not assert.equal: on failure node:assert would try to diff
    // two live jsdom nodes and walk the whole document graph (AGENTS.md).
    assert.ok(document.activeElement === input);
  });

  it('submits what was typed', async () => {
    const { user, input, submit, onSubmit } = setup();
    await user.type(input, 'anonymous');
    await user.click(submit);
    assert.deepEqual(onSubmit.mock.calls, [['anonymous']]);
  });

  it('submits on Enter', async () => {
    const { user, input, onSubmit } = setup();
    await user.type(input, 'team-b{Enter}');
    assert.deepEqual(onSubmit.mock.calls, [['team-b']]);
  });

  it('trims the tenant, since it becomes a header value', async () => {
    const { user, input, submit, onSubmit } = setup();
    await user.type(input, '  team-a  ');
    await user.click(submit);
    assert.deepEqual(onSubmit.mock.calls, [['team-a']]);
  });

  it('refuses to submit nothing', async () => {
    // The dialog is not dismissible: without a tenant no query can be made,
    // so an empty submit has to keep it open rather than proceed.
    const { user, input, submit, onSubmit } = setup();
    await user.click(submit);
    await user.type(input, '   ');
    await user.click(submit);
    assert.equal(onSubmit.mock.calls.length, 0);
    assert.ok(screen.getByRole('dialog'));
  });

  it('lets the pointer put focus back in the field', async () => {
    // The backdrop cancels mousedown so a click outside cannot drop focus to
    // <body> and let Tab escape to the app behind the overlay. That guard has
    // to stop at the backdrop itself: React bubbles the event, so cancelling
    // it for the whole subtree also cancels focusing the input, and the user
    // can neither click into the field nor select the text in it.
    const { user, input, submit } = setup('team-a');
    submit.focus();
    await user.click(input);
    assert.ok(document.activeElement === input);
  });

  it('keeps Tab inside the dialog', async () => {
    const { user, input, submit } = setup('team-a');
    input.focus();
    await user.tab();
    assert.ok(document.activeElement === submit);
    await user.tab();
    assert.ok(document.activeElement === input);
    await user.tab({ shift: true });
    assert.ok(document.activeElement === submit);
  });
});
