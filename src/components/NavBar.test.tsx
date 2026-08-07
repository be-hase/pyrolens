import { fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { NavBar } from './NavBar.tsx';

const at = (search: string) => window.history.replaceState(null, '', search);

const setup = (
  props: Partial<React.ComponentProps<typeof NavBar>> = {},
): { onThemeChange: ReturnType<typeof vi.fn> } => {
  const onThemeChange = vi.fn();
  render(
    <NavBar
      activeView="single"
      theme="dark"
      onThemeChange={onThemeChange}
      {...props}
    />,
  );
  return { onThemeChange };
};

const tab = (name: string) => screen.getByRole('link', { name });

beforeEach(() => at('/'));

describe('NavBar', () => {
  it('links to every view', () => {
    setup();
    assert.equal(tab('Single').getAttribute('href'), '/');
    assert.equal(tab('Comparison').getAttribute('href'), '/comparison');
    assert.equal(tab('Diff').getAttribute('href'), '/diff');
    assert.equal(tab('Tag Explorer').getAttribute('href'), '/explore');
  });

  it('carries the current params into every link', () => {
    // Switching views must not drop the query, range or tenant — and the
    // href has to hold them too, so opening a tab in a new window works.
    at('/?query=%7Ba%3D%22b%22%7D&from=now-6h&tenant=team-a');
    setup();
    for (const name of ['Comparison', 'Diff', 'Tag Explorer']) {
      const href = tab(name).getAttribute('href') ?? '';
      const params = new URLSearchParams(href.slice(href.indexOf('?')));
      assert.equal(params.get('query'), '{a="b"}', name);
      assert.equal(params.get('from'), 'now-6h', name);
      assert.equal(params.get('tenant'), 'team-a', name);
    }
  });

  it('marks the active view', () => {
    setup({ activeView: 'diff' });
    assert.ok(tab('Diff').classList.contains('active'));
    assert.ok(!tab('Single').classList.contains('active'));
  });

  it('navigates in place on a plain click', () => {
    at('/?query=%7B%7D');
    setup();
    fireEvent.click(tab('Comparison'), { button: 0 });
    assert.equal(window.location.pathname, '/comparison');
    assert.equal(
      new URLSearchParams(window.location.search).get('query'),
      '{}',
    );
  });

  it('leaves a Cmd-click to the browser', () => {
    // The click is left uncancelled, so jsdom logs that it will not follow
    // the link — which is the point: a real browser opens a new tab.
    setup();
    fireEvent.click(tab('Comparison'), { button: 0, metaKey: true });
    assert.equal(window.location.pathname, '/');
  });

  it('hides the tenant button in single-tenant mode', () => {
    setup();
    assert.equal(screen.queryByTitle('Change tenant'), null);
  });

  it('shows the active tenant and offers to change it', () => {
    const onChangeTenant = vi.fn();
    setup({ tenantID: 'team-a', onChangeTenant });
    const button = screen.getByTitle('Change tenant');
    assert.equal(button.textContent, 'team-a');
    fireEvent.click(button);
    assert.equal(onChangeTenant.mock.calls.length, 1);
  });

  it('switches the theme', () => {
    const { onThemeChange } = setup({ theme: 'dark' });
    const picker = screen.getByRole('button', { name: /Dark/ });
    fireEvent.click(picker);
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '.dropdown .select-option:last-child',
      )!,
    );
    assert.deepEqual(onThemeChange.mock.calls, [['light']]);
  });
});
