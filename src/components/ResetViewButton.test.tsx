import { fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { buildQuery } from '../queryLang';
import { ResetViewButton } from './ResetViewButton.tsx';

const at = (search: string) => window.history.replaceState(null, '', search);
const params = () => new URLSearchParams(window.location.search);

const CPU = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';
const QUERY = `{service_name="checkout", profile_type="${CPU}"}`;
const QUERY_WITH_EXTRA = `{service_name="checkout", profile_type="${CPU}", region="eu-west"}`;

const enc = encodeURIComponent;

// Accessible name is pinned via aria-label ("Reset view"), independent of
// whatever the visible label ends up saying.
const resetButton = () => screen.queryByRole('button', { name: 'Reset view' });

afterEach(() => at('/'));

describe('ResetViewButton visibility', () => {
  it('(a) renders nothing on a bare path with no params at all', () => {
    at('/');
    render(<ResetViewButton />);
    assert.ok(!resetButton());
  });

  it('(a) renders nothing when the URL already holds exactly tenant + a canonical service/profile_type query', () => {
    at(`/?tenant=acme&query=${enc(QUERY)}`);
    render(<ResetViewButton />);
    assert.ok(!resetButton());
  });

  it('(b) renders when a view-only param (fgSearch) is present alongside an otherwise-default URL', () => {
    at(`/?tenant=acme&query=${enc(QUERY)}&fgSearch=foo`);
    render(<ResetViewButton />);
    assert.ok(resetButton());
  });

  it('(b) renders when the query carries an extra matcher beyond service_name/profile_type', () => {
    at(`/?tenant=acme&query=${enc(QUERY_WITH_EXTRA)}`);
    render(<ResetViewButton />);
    assert.ok(resetButton());
  });

  it('(b) renders when the range has moved off the default (from/until present)', () => {
    at(
      `/?tenant=acme&query=${enc(QUERY)}&from=1700000000000&until=1700003600000`,
    );
    render(<ResetViewButton />);
    assert.ok(resetButton());
  });

  it('renders when the query is present but does not parse at all', () => {
    at('/?tenant=acme&query=not-a-query');
    render(<ResetViewButton />);
    assert.ok(resetButton());
  });

  it('renders nothing when the query is entirely absent, even with a tenant set', () => {
    at('/?tenant=acme');
    render(<ResetViewButton />);
    assert.ok(!resetButton());
  });
});

describe('ResetViewButton click behaviour', () => {
  it('(c) pushes a navigation that keeps the pathname and tenant, rebuilds query to service_name/profile_type only, and drops every other param', () => {
    at(
      `/comparison?tenant=acme&query=${enc(QUERY_WITH_EXTRA)}` +
        '&from=1700000000000&until=1700003600000&refresh=30s' +
        '&groupBy=region&sort=max&fgSearch=foo&fgSandwich=main.fn' +
        `&maxNodes=500&leftQuery=${enc('{}')}&leftFrom=1&leftUntil=2` +
        `&rightQuery=${enc('{}')}&rightFrom=3&rightUntil=4`,
    );
    render(<ResetViewButton />);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');

    fireEvent.click(resetButton()!);

    assert.equal(window.location.pathname, '/comparison');
    assert.deepEqual([...params().keys()].sort(), ['query', 'tenant']);
    assert.equal(params().get('tenant'), 'acme');
    assert.equal(params().get('query'), buildQuery('checkout', CPU));
    // Back has to restore the messy state, so this must be a push.
    assert.equal(pushSpy.mock.calls.length, 1);
    assert.equal(replaceSpy.mock.calls.length, 0);
  });

  it('(d) clears `query` entirely, rather than keeping any part of it, when the current query does not parse', () => {
    at('/?tenant=acme&query=not-a-query&fgSearch=foo');
    render(<ResetViewButton />);

    fireEvent.click(resetButton()!);

    assert.equal(params().has('query'), false);
    assert.equal(params().has('fgSearch'), false);
    assert.equal(params().get('tenant'), 'acme');
  });

  it('(d) clears `query` entirely when it parses but is missing service_name or profile_type', () => {
    at(`/?tenant=acme&query=${enc('{region="eu-west"}')}`);
    render(<ResetViewButton />);

    fireEvent.click(resetButton()!);

    assert.equal(params().has('query'), false);
    assert.equal(params().get('tenant'), 'acme');
  });

  it('drops the button (re-renders hidden) once the reset URL is reached', () => {
    at(`/?tenant=acme&query=${enc(QUERY)}&fgSearch=foo`);
    render(<ResetViewButton />);
    assert.ok(resetButton());

    fireEvent.click(resetButton()!);
    // urlState dispatches 'pyroscope:navigate' synchronously from pushState,
    // and useRoute subscribes to it, so the component re-renders in the same
    // tick without needing act()/waitFor().
    assert.ok(!resetButton());
  });

  it('works with no tenant param at all (single-tenant mode)', () => {
    at(`/?query=${enc(QUERY_WITH_EXTRA)}`);
    render(<ResetViewButton />);

    fireEvent.click(resetButton()!);

    assert.equal(params().has('tenant'), false);
    assert.equal(params().get('query'), buildQuery('checkout', CPU));
  });
});
