import { act, fireEvent, render, screen, within } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { fetchesInFlight } from '@api/client';
import { RefreshPicker } from './RefreshPicker.tsx';

vi.mock('@api/client', () => ({ fetchesInFlight: vi.fn() }));

const inFlightOf = vi.mocked(fetchesInFlight);

const at = (search: string) => window.history.replaceState(null, '', search);
const params = () => new URLSearchParams(window.location.search);

// Counts 'pyroscope:navigate' dispatches — what a tick (and the
// visibility-return refresh) actually does, rather than asserting on the URL,
// which a no-op navigate({ set: {} }) leaves unchanged.
function countNavigations() {
  let count = 0;
  const onNav = () => {
    count++;
  };
  window.addEventListener('pyroscope:navigate', onNav);
  return {
    get count() {
      return count;
    },
    cleanup: () => window.removeEventListener('pyroscope:navigate', onNav),
  };
}

// The trigger's accessible name is "Refresh interval: <value>"; its visible
// text is just the value, which the dropdown's options repeat, so lookups by
// role keep the two apart.
const trigger = () =>
  screen.getByRole('button', {
    name: /^Refresh interval: (Off|10s|30s|1m|5m)$/,
  });

const panel = () => {
  const el = document.querySelector<HTMLElement>('.dropdown');
  assert.ok(el, 'dropdown is not open');
  return within(el);
};

const openPicker = (from = 'now-1h', until = 'now') => {
  render(<RefreshPicker from={from} until={until} />);
  const el = trigger();
  fireEvent.click(el);
  return el;
};

beforeEach(() => {
  at('/');
  inFlightOf.mockReturnValue(0);
});

describe('RefreshPicker', () => {
  it('shows "Off" and writes no param when refresh is absent', () => {
    render(<RefreshPicker from="now-1h" until="now" />);
    assert.ok(screen.getByRole('button', { name: 'Refresh interval: Off' }));
  });

  it('names the trigger for screen readers', () => {
    at('/?refresh=30s');
    render(<RefreshPicker from="now-1h" until="now" />);
    assert.ok(screen.getByRole('button', { name: 'Refresh interval: 30s' }));
  });

  it('lists the presets as options, with the active one marked selected', () => {
    const el = openPicker();
    const options = panel().getAllByRole('option');
    assert.deepEqual(
      options.map((o) => o.textContent),
      ['Off', '10s', '30s', '1m', '5m'],
    );
    assert.equal(
      panel().getByText('Off').getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      panel().getByText('30s').getAttribute('aria-selected'),
      'false',
    );
    assert.equal(el.getAttribute('aria-haspopup'), 'listbox');
  });

  it('selecting an interval writes it to the URL; selecting Off removes it', () => {
    const el = openPicker();
    fireEvent.click(panel().getByText('30s'));
    assert.equal(params().get('refresh'), '30s');
    assert.equal(el.textContent, '30s');

    fireEvent.click(trigger());
    fireEvent.click(panel().getByText('Off'));
    assert.equal(params().has('refresh'), false);
  });

  it('treats an unrecognised refresh value as off, without crashing', () => {
    at('/?refresh=bogus');
    render(<RefreshPicker from="now-1h" until="now" />);
    assert.ok(screen.getByRole('button', { name: 'Refresh interval: Off' }));
  });

  describe('ticking', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('ticks every interval while the range is relative-ending-at-now', () => {
      at('/?refresh=30s');
      render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      act(() => vi.advanceTimersByTime(30_000));
      assert.equal(nav.count, 1);

      act(() => vi.advanceTimersByTime(60_000));
      assert.equal(nav.count, 3);

      nav.cleanup();
    });

    it('does not tick when the range is absolute', () => {
      at('/?refresh=30s');
      render(<RefreshPicker from="1700000000000" until="1700003600000" />);
      const nav = countNavigations();

      act(() => vi.advanceTimersByTime(120_000));
      assert.equal(nav.count, 0);

      nav.cleanup();
    });

    it('does not tick for an unrecognised refresh value', () => {
      at('/?refresh=bogus');
      render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      act(() => vi.advanceTimersByTime(120_000));
      assert.equal(nav.count, 0);

      nav.cleanup();
    });

    it('skips a tick while a fetch it triggered is still in flight, retrying next interval', () => {
      // A query slower than the refresh interval must not be aborted and
      // reissued forever — the tick that would do that is skipped, and the
      // one after retries once the slot frees up.
      at('/?refresh=30s');
      render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      inFlightOf.mockReturnValue(1);
      act(() => vi.advanceTimersByTime(30_000));
      assert.equal(nav.count, 0, 'tick skipped while a fetch is pending');

      inFlightOf.mockReturnValue(0);
      act(() => vi.advanceTimersByTime(30_000));
      assert.equal(nav.count, 1, 'next tick fires once nothing is pending');

      nav.cleanup();
    });

    it('does not leak the interval after unmount', () => {
      at('/?refresh=30s');
      const { unmount } = render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      unmount();
      act(() => vi.advanceTimersByTime(300_000));
      assert.equal(nav.count, 0, 'no navigation from a timer left running');

      nav.cleanup();
    });
  });

  describe('visibility', () => {
    const originalHidden = document.hidden;

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(document, 'hidden', {
        value: originalHidden,
        configurable: true,
      });
    });

    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', {
        value: hidden,
        configurable: true,
      });
    };

    it('pauses while hidden, then refreshes once immediately on return', () => {
      at('/?refresh=30s');
      render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      setHidden(true);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      act(() => vi.advanceTimersByTime(120_000));
      assert.equal(nav.count, 0, 'no tick while hidden');

      setHidden(false);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.equal(nav.count, 1, 'one immediate refresh on return');

      // Resumes the normal cadence afterwards.
      act(() => vi.advanceTimersByTime(30_000));
      assert.equal(nav.count, 2);

      nav.cleanup();
    });

    it('skips the immediate refresh on return while a fetch is still in flight', () => {
      at('/?refresh=30s');
      render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      setHidden(true);
      act(() => document.dispatchEvent(new Event('visibilitychange')));

      inFlightOf.mockReturnValue(1);
      setHidden(false);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.equal(
        nav.count,
        0,
        'no immediate refresh while a fetch is pending',
      );

      // The normal cadence still resumes, once whatever was pending clears.
      inFlightOf.mockReturnValue(0);
      act(() => vi.advanceTimersByTime(30_000));
      assert.equal(nav.count, 1);

      nav.cleanup();
    });

    it('does not navigate on a visibilitychange dispatched after unmount', () => {
      at('/?refresh=30s');
      const { unmount } = render(<RefreshPicker from="now-1h" until="now" />);
      const nav = countNavigations();

      setHidden(true);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      unmount();

      setHidden(false);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.equal(nav.count, 0);

      nav.cleanup();
    });
  });
});
