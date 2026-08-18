import { act, fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { MaxNodesControl } from './MaxNodesControl.tsx';
import { navigate } from '../urlState';

// The debounce (MaxNodesControl.tsx's COMMIT_DEBOUNCE_MS) needs fake timers
// to test without slowing the suite down or racing real time — same
// technique RefreshPicker.test.tsx uses for its ticking interval.
const COMMIT_DEBOUNCE_MS = 350;

const at = (search: string) => window.history.replaceState(null, '', search);
const params = () => new URLSearchParams(window.location.search);

// Counts 'pyroscope:navigate' dispatches — the same technique
// RefreshPicker.test.tsx uses to prove a per-tick drag does not navigate
// (navigate() can replaceState without changing the URL string in a way a
// bare URL comparison would catch).
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

// React sets a controlled input's position via the `.value` DOM property,
// not the `value` attribute — `getAttribute('value')` would only ever show
// the initial render (or nothing), so every read goes through the property.
const slider = () =>
  screen.getByRole('slider', { name: 'Max nodes' }) as HTMLInputElement;

beforeEach(() => {
  at('/');
  vi.useFakeTimers();
});
afterEach(() => {
  at('/');
  vi.useRealTimers();
});

describe('MaxNodesControl', () => {
  it('renders at the Default (rightmost) position with no maxNodes param', () => {
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '8');
    assert.equal(el.getAttribute('aria-valuetext'), 'Default');
  });

  it('renders at the matching preset position for ?maxNodes=4096', () => {
    at('/?maxNodes=4096');
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '3');
    assert.equal(el.getAttribute('aria-valuetext'), '4k');
  });

  it('dragging (input events) updates the label live but does not navigate, even after the commit debounce would have elapsed', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    fireEvent.input(el, { target: { value: '2' } });
    assert.equal(el.getAttribute('aria-valuetext'), '2k');
    assert.equal(screen.getByText('2k').textContent, '2k');
    assert.equal(nav.count, 0);
    assert.equal(params().has('maxNodes'), false);

    // A plain `input` (no `change`) never sets a pending commit, so there is
    // nothing for the debounce to eventually fire.
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));
    assert.equal(nav.count, 0);
    assert.equal(params().has('maxNodes'), false);

    nav.cleanup();
  });

  it('debounces the change event: nothing navigates until the commit has been quiet for COMMIT_DEBOUNCE_MS', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    fireEvent.input(el, { target: { value: '5' } });
    fireEvent.change(el, { target: { value: '5' } });

    // Still nothing — inside the debounce window.
    assert.equal(nav.count, 0);
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS - 1));
    assert.equal(nav.count, 0);
    assert.equal(params().has('maxNodes'), false);

    act(() => vi.advanceTimersByTime(1));
    assert.equal(nav.count, 1);
    assert.equal(params().get('maxNodes'), '16384');

    nav.cleanup();
  });

  it('coalesces a burst of rapid change events (keyboard auto-repeat) into a single navigation with the final value', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    // Simulates holding an arrow key: auto-repeat fires input+change on
    // every repeat tick, well inside the debounce window. Index 8 -> 5.
    for (const v of ['7', '6', '5']) {
      fireEvent.input(el, { target: { value: v } });
      fireEvent.change(el, { target: { value: v } });
    }
    assert.equal(nav.count, 0);

    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));

    // Exactly one navigation, carrying only the last value in the burst —
    // a regression that committed per tick would show up here as 3.
    assert.equal(nav.count, 1);
    assert.equal(params().get('maxNodes'), '16384');

    nav.cleanup();
  });

  it('choosing Default removes the maxNodes param once the debounce settles', () => {
    at('/?maxNodes=4096');
    render(<MaxNodesControl />);
    const el = slider();

    fireEvent.change(el, { target: { value: '8' } });
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));

    assert.equal(params().has('maxNodes'), false);
  });

  it('resets the draft when the URL maxNodes changes underneath it', () => {
    at('/?maxNodes=1024');
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '1');

    // Mid-drag: only an `input` fired, nothing committed yet.
    fireEvent.input(el, { target: { value: '6' } });
    assert.equal(el.value, '6');

    // Some other actor (a deep link, Back, another control) writes maxNodes
    // out from under the in-progress drag.
    act(() => navigate({ set: { maxNodes: '8192' } }));

    assert.equal(el.value, '4');
    assert.equal(el.getAttribute('aria-valuetext'), '8k');
  });

  it('drops a pending debounced commit when the URL maxNodes moves underneath it before the debounce settles', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    // Commits a change to index 3 (4096); the debounce starts, targeting a
    // world where maxNodes is still absent (committedIndex 8 = Default).
    fireEvent.input(el, { target: { value: '3' } });
    fireEvent.change(el, { target: { value: '3' } });
    assert.equal(nav.count, 0);

    // Before it settles, some other actor rewrites maxNodes directly —
    // useEditBuffer resets the draft to follow it.
    act(() => navigate({ set: { maxNodes: '1024' } }));
    assert.equal(nav.count, 1);
    assert.equal(el.value, '1');

    // The pending commit's debounce elapses now. It must not fire and
    // silently overwrite the external write with the stale value 4096 —
    // pendingBaseline (captured as 8 at commit time) no longer matches
    // committedIndex (now 1), so MaxNodesControl drops it instead of
    // navigating.
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));
    assert.equal(nav.count, 1);
    assert.equal(params().get('maxNodes'), '1024');

    nav.cleanup();
  });
});
