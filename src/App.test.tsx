import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import {
  checkMultitenancy,
  fetchServices,
  setTenant,
  type Service,
} from '@api/client';
import { App } from './App.tsx';
import { navigate } from './urlState.ts';
import type { ViewProps } from './App.tsx';

vi.mock('@api/client', () => ({
  checkMultitenancy: vi.fn(),
  fetchServices: vi.fn(),
  setTenant: vi.fn(),
  sortProfileTypes: (types: string[]) => [...types].sort(),
}));

// The views draw to canvas, which jsdom has no implementation for; these
// stubs report the props App resolved out of the URL instead. Declared as a
// function so it exists by the time the hoisted vi.mock factories run.
function stub(name: string) {
  return (props: ViewProps) => (
    <div data-testid={name}>
      <span data-testid="query">{props.query}</span>
      <span data-testid="range">{`${props.range.start}-${props.range.end}`}</span>
      <span data-testid="tenant">{props.tenantID ?? ''}</span>
      <span data-testid="services">
        {props.services.map((s) => s.name).join()}
      </span>
    </div>
  );
}
vi.mock('./views/SingleView', () => ({ SingleView: stub('single') }));
vi.mock('./views/ComparisonView', () => ({
  ComparisonView: stub('comparison'),
}));
vi.mock('./views/DiffView', () => ({ DiffView: stub('diff') }));
vi.mock('./views/TagExplorerView', () => ({
  TagExplorerView: stub('explore'),
}));

const multitenancyOf = vi.mocked(checkMultitenancy);
const servicesOf = vi.mocked(fetchServices);
const setTenantOf = vi.mocked(setTenant);

const WEB: Service = {
  name: 'web',
  profileTypes: ['memory:alloc_space:bytes:space:bytes', 'a:cpu:c:d:e'],
};

const at = (url: string) => window.history.replaceState(null, '', url);
const params = () => new URLSearchParams(window.location.search);
const seen = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  at('/');
  localStorage.clear();
  multitenancyOf.mockResolvedValue(false);
  servicesOf.mockResolvedValue([WEB]);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('App tenancy', () => {
  it('renders the view once the server turns out to be single-tenant', async () => {
    at('/?query=%7Ba%3D%22b%22%7D');
    render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    assert.equal(seen('query'), '{a="b"}');
    assert.equal(seen('tenant'), '');
    assert.ok(!screen.queryByRole('dialog'));
  });

  it('asks for a tenant when the server is multi-tenant', async () => {
    multitenancyOf.mockResolvedValue(true);
    render(<App />);
    await waitFor(() => assert.ok(screen.getByRole('dialog')));
    // Nothing may be queried before a tenant is chosen.
    assert.equal(servicesOf.mock.calls.length, 0);
    assert.ok(!screen.queryByTestId('single'));
  });

  it('adopts the tenant from the URL', async () => {
    multitenancyOf.mockResolvedValue(true);
    at('/?tenant=team-a&query=%7B%7D');
    render(<App />);
    await waitFor(() => assert.equal(seen('tenant'), 'team-a'));
    assert.ok(!screen.queryByRole('dialog'));
  });

  it('writes a remembered tenant back into the URL', async () => {
    // The address stays the single source of truth, so the restored session
    // is still shareable.
    multitenancyOf.mockResolvedValue(true);
    localStorage.setItem('pyrolens:tenant', 'team-a');
    render(<App />);
    await waitFor(() => assert.equal(params().get('tenant'), 'team-a'));
  });

  it('remembers the tenant chosen in the dialog', async () => {
    multitenancyOf.mockResolvedValue(true);
    render(<App />);
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'team-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => assert.equal(params().get('tenant'), 'team-b'));
    assert.equal(localStorage.getItem('pyrolens:tenant'), 'team-b');
  });

  it('explains an unreachable server instead of rendering a view', async () => {
    multitenancyOf.mockRejectedValueOnce(new Error('connection refused'));
    render(<App />);
    await waitFor(() =>
      assert.match(
        document.body.textContent ?? '',
        /Failed to reach Pyroscope/,
      ),
    );
    assert.match(document.body.textContent ?? '', /connection refused/);
    assert.ok(!screen.queryByTestId('single'));
  });

  it('sets the tenant header before anything is fetched for it', async () => {
    // Synced outside React, so no request can go out against the tenant that
    // was current a moment ago.
    const order: string[] = [];
    setTenantOf.mockImplementation((t) => void order.push(`setTenant:${t}`));
    servicesOf.mockImplementation(async () => {
      order.push('fetchServices');
      return [WEB];
    });
    multitenancyOf.mockResolvedValue(true);
    at('/?tenant=team-a&query=%7B%7D');

    render(<App />);
    await waitFor(() => assert.equal(seen('tenant'), 'team-a'));
    await waitFor(() => assert.ok(order.includes('fetchServices')));

    act(() => navigate({ set: { tenant: 'team-b' } }));
    await waitFor(() => assert.equal(seen('tenant'), 'team-b'));
    await waitFor(() =>
      assert.ok(
        order.lastIndexOf('fetchServices') > order.indexOf('setTenant:team-b'),
        order.join(' → '),
      ),
    );
  });

  it('surfaces a failing service list without hiding the view', async () => {
    servicesOf.mockRejectedValueOnce(new Error('service list unavailable'));
    render(<App />);
    await waitFor(() =>
      assert.match(
        document.body.textContent ?? '',
        /Failed to load the service/,
      ),
    );
    assert.match(document.body.textContent ?? '', /service list unavailable/);
    assert.ok(screen.getByTestId('single'));
  });
});

describe('App routing', () => {
  it('renders the view for the current path', async () => {
    for (const [path, id] of [
      ['/', 'single'],
      ['/comparison', 'comparison'],
      ['/diff', 'diff'],
      ['/explore', 'explore'],
      ['/nonsense', 'single'],
    ]) {
      at(`${path}?query=%7B%7D`);
      const { unmount } = render(<App />);
      await waitFor(() => assert.ok(screen.getByTestId(id), path));
      unmount();
    }
  });

  it('follows navigation without a reload', async () => {
    at('/?query=%7B%7D');
    render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    act(() => navigate({ path: '/diff' }));
    await waitFor(() => assert.ok(screen.getByTestId('diff')));
  });
});

describe('App defaults', () => {
  it('defaults the range to the last hour', async () => {
    at('/?query=%7B%7D');
    render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    const [start, end] = (seen('range') ?? '').split('-').map(Number);
    assert.equal(end - start, 3_600_000);
  });

  it('advances "now" on every navigation, even one that changes nothing', async () => {
    // That is what makes Run a real refresh for a relative range.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    at('/?query=%7B%7D&from=now-1h&until=now');
    render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    const before = seen('range');

    clock.mockReturnValue(1_800_000_060_000);
    act(() => navigate({ set: { query: '{}' } }));
    await waitFor(() => assert.notEqual(seen('range'), before));
    assert.equal(seen('range'), '1799996460000-1800000060000');
  });

  it('holds "now" still between navigations, so renders stay pure', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    at('/?query=%7B%7D');
    const { rerender } = render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    const before = seen('range');
    clock.mockReturnValue(1_900_000_000_000);
    rerender(<App />);
    assert.equal(seen('range'), before);
  });

  it('picks a first query when the URL has none', async () => {
    render(<App />);
    await waitFor(() => assert.ok(params().get('query')));
    assert.equal(
      params().get('query'),
      '{service_name="web", profile_type="a:cpu:c:d:e"}',
    );
  });

  it('leaves an existing query alone', async () => {
    at('/?query=%7Bmine%3D%22yes%22%7D');
    render(<App />);
    await waitFor(() => assert.ok(screen.getByTestId('single')));
    assert.equal(params().get('query'), '{mine="yes"}');
  });

  it('hands the loaded services to the view', async () => {
    render(<App />);
    await waitFor(() => assert.equal(seen('services'), 'web'));
  });
});

describe('App theme', () => {
  it('starts dark and remembers the choice', async () => {
    render(<App />);
    await waitFor(() =>
      assert.equal(document.documentElement.getAttribute('data-theme'), 'dark'),
    );
    assert.equal(localStorage.getItem('pyrolens:theme'), 'dark');
  });

  it('restores the theme from the previous visit', async () => {
    localStorage.setItem('pyrolens:theme', 'light');
    render(<App />);
    await waitFor(() =>
      assert.equal(
        document.documentElement.getAttribute('data-theme'),
        'light',
      ),
    );
  });
});
