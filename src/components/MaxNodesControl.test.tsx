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
// The accessible name now comes from the visible "Max nodes" label
// (Slider's aria-labelledby, see MaxNodesControl.tsx) rather than a
// duplicate aria-label string, so this query also proves that wiring.
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
  it('renders at Default (index 0, the LEFT end) with no maxNodes param', () => {
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '0');
    assert.equal(el.getAttribute('aria-valuetext'), 'Default');
  });

  it('renders a visible "Max nodes" label and a tooltip explaining the control', () => {
    render(<MaxNodesControl />);
    assert.ok(screen.getByText('Max nodes'));
    const wrapper = document.querySelector('.max-nodes-control');
    assert.ok(wrapper?.getAttribute('title'));
  });

  it('renders the dot and bar rail elements (real markup, not a track gradient)', () => {
    render(<MaxNodesControl />);
    assert.ok(document.querySelector('.max-nodes-rail-dot'));
    assert.ok(document.querySelector('.max-nodes-rail-bar'));
  });

  it('renders at the matching preset position for ?maxNodes=4096 (index 4: Default=0, then presets ascending)', () => {
    at('/?maxNodes=4096');
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '4');
    assert.equal(el.getAttribute('aria-valuetext'), '4k');
  });

  it('ArrowLeft from Default is a hard stop: it cannot go below index 0 and never navigates', () => {
    // jsdom does not implement a range input's native "arrow key decrements
    // by step" browser behaviour, so a dispatched ArrowLeft keydown would be
    // a no-op regardless of whether the app is correct — it would prove
    // nothing either way. What IS testable, and is the same clamp ArrowLeft
    // relies on, is the input's value-sanitization algorithm: a native
    // range input clamps any assigned value to [min, max], so attempting to
    // move below `min={0}` exercises the identical hard stop.
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();
    assert.equal(el.value, '0');

    fireEvent.input(el, { target: { value: '-1' } });
    assert.equal(el.value, '0');
    fireEvent.change(el, { target: { value: '-1' } });
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));

    assert.equal(nav.count, 0);
    assert.equal(params().has('maxNodes'), false);

    nav.cleanup();
  });

  it('dragging (input events) updates the label live but does not navigate, even after the commit debounce would have elapsed', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    fireEvent.input(el, { target: { value: '5' } });
    assert.equal(el.getAttribute('aria-valuetext'), '8k');
    assert.equal(screen.getByText('8k').textContent, '8k');
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
    assert.equal(params().get('maxNodes'), '8192');

    nav.cleanup();
  });

  it('coalesces a burst of rapid change events (keyboard auto-repeat) into a single navigation with the final value', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    // Simulates holding an arrow key: auto-repeat fires input+change on
    // every repeat tick, well inside the debounce window. Index 0 -> 3.
    for (const v of ['1', '2', '3']) {
      fireEvent.input(el, { target: { value: v } });
      fireEvent.change(el, { target: { value: v } });
    }
    assert.equal(nav.count, 0);

    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));

    // Exactly one navigation, carrying only the last value in the burst —
    // a regression that committed per tick would show up here as 3.
    assert.equal(nav.count, 1);
    assert.equal(params().get('maxNodes'), '2048');

    nav.cleanup();
  });

  it('choosing Default removes the maxNodes param once the debounce settles', () => {
    at('/?maxNodes=4096');
    render(<MaxNodesControl />);
    const el = slider();

    fireEvent.change(el, { target: { value: '0' } });
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));

    assert.equal(params().has('maxNodes'), false);
  });

  it('resets the draft when the URL maxNodes changes underneath it', () => {
    at('/?maxNodes=1024');
    render(<MaxNodesControl />);
    const el = slider();
    assert.equal(el.value, '2');

    // Mid-drag: only an `input` fired, nothing committed yet.
    fireEvent.input(el, { target: { value: '6' } });
    assert.equal(el.value, '6');

    // Some other actor (a deep link, Back, another control) writes maxNodes
    // out from under the in-progress drag.
    act(() => navigate({ set: { maxNodes: '8192' } }));

    assert.equal(el.value, '5');
    assert.equal(el.getAttribute('aria-valuetext'), '8k');
  });

  it('drops a pending debounced commit when the URL maxNodes moves underneath it before the debounce settles', () => {
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    // Commits a change to index 3 (2048); the debounce starts, targeting a
    // world where maxNodes is still absent (committedIndex 0 = Default).
    fireEvent.input(el, { target: { value: '3' } });
    fireEvent.change(el, { target: { value: '3' } });
    assert.equal(nav.count, 0);

    // Before it settles, some other actor rewrites maxNodes directly —
    // useEditBuffer resets the draft to follow it.
    act(() => navigate({ set: { maxNodes: '1024' } }));
    assert.equal(nav.count, 1);
    assert.equal(el.value, '2');

    // The pending commit's debounce elapses now. It must not fire and
    // silently overwrite the external write with the stale value 2048 —
    // pendingBaseline (captured as 0 at commit time) no longer matches
    // committedIndex (now 2), so MaxNodesControl drops it instead of
    // navigating.
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));
    assert.equal(nav.count, 1);
    assert.equal(params().get('maxNodes'), '1024');

    nav.cleanup();
  });

  it('(c) drops a pending commit made while maxNodes was absent, when a push lands mid-debounce and maxNodes is still absent afterwards', () => {
    // The previous test's guard (pendingBaseline vs committedIndex) is blind
    // to this shape: maxNodes was never present, so
    // indexForMaxNodes(undefined) is DEFAULT_INDEX (0) both before and after
    // the push below — baseline and committedIndex still agree, even though
    // the user's context genuinely moved (e.g. Reset view, clearing every
    // OTHER param). Only the push-generation guard catches it.
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    // Commit to index 3 (2048) from Default.
    fireEvent.input(el, { target: { value: '3' } });
    fireEvent.change(el, { target: { value: '3' } });
    assert.equal(nav.count, 0);

    // A push that never touches maxNodes at all — a real navigation
    // (pathname changes), so it bumps urlState's push generation.
    act(() => navigate({ path: '/comparison' }));
    assert.equal(nav.count, 1);
    assert.equal(params().has('maxNodes'), false);

    // The stale commit's debounce elapses now. It must not fire.
    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));
    assert.equal(
      nav.count,
      1,
      'the stale commit must not cause a second navigation',
    );
    assert.equal(params().has('maxNodes'), false);

    nav.cleanup();
  });

  it('(e) a background replace navigation mid-debounce does not cancel a pending commit', () => {
    // Regression guard for the push-generation check above: a replace (e.g.
    // the flame graph search's debounced write) is a background write
    // settling, not a context switch, and must not be mistaken for one —
    // urlState.ts's pushGenerationNow only moves on a push or a popstate.
    render(<MaxNodesControl />);
    const nav = countNavigations();
    const el = slider();

    fireEvent.input(el, { target: { value: '3' } });
    fireEvent.change(el, { target: { value: '3' } });
    assert.equal(nav.count, 0);

    act(() => navigate({ set: { fgSearch: 'alloc' }, replace: true }));
    assert.equal(nav.count, 1);

    act(() => vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS));
    assert.equal(nav.count, 2, 'the slider commit must still land');
    assert.equal(params().get('maxNodes'), '2048');

    nav.cleanup();
  });
});
