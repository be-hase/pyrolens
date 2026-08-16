import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  flameGraphUrlState,
  sandwichNavigateOptions,
  searchNavigateOptions,
} from '@hooks/useFlameGraphUrlState';

// The wrapper's actual JSX renders the vendored flame graph, which needs a
// real canvas context to mount without throwing — jsdom does not provide
// one (see AGENTS.md's "Verifying a change" section: "jsdom has no
// implementation" for canvas transforms). So this covers the URL<->prop
// mapping useFlameGraphUrlState is built on directly, rather than rendering
// the component tree; e2e/views.spec.ts is what exercises the real thing in
// a browser, including the search input the container renders and the
// Comparison ping-pong that the searchNavigateOptions guard exists to stop.
//
// NOT covered here: that FlameGraphContainer actually reads its
// `sandwichItem`/`search` props from these values (a rendering concern),
// and that the container's own reset-on-data-change effect leaves a
// controlled sandwich alone (verified by hand against FlameGraphContainer.tsx
// while implementing it, since it isn't reachable from jsdom either).

describe('flameGraphUrlState', () => {
  it('reads fgSearch and fgSandwich off the URL', () => {
    const state = flameGraphUrlState(
      new URLSearchParams('fgSearch=alloc&fgSandwich=main.queryDatabase'),
    );
    assert.deepEqual(state, {
      search: 'alloc',
      sandwichItem: 'main.queryDatabase',
    });
  });

  it('defaults to an empty search and no sandwich when absent', () => {
    const state = flameGraphUrlState(new URLSearchParams(''));
    assert.deepEqual(state, { search: '', sandwichItem: undefined });
  });
});

describe('sandwichNavigateOptions', () => {
  it('replaces, and writes the label as fgSandwich', () => {
    assert.deepEqual(sandwichNavigateOptions('main.queryDatabase'), {
      replace: true,
      set: { fgSandwich: 'main.queryDatabase' },
    });
  });

  it('replaces, and clears fgSandwich when the selection is undone', () => {
    // Reset / toggling the same item off calls this with undefined; the
    // wrapper must remove the param rather than write the literal string
    // "undefined".
    assert.deepEqual(sandwichNavigateOptions(undefined), {
      replace: true,
      set: { fgSandwich: null },
    });
  });
});

describe('searchNavigateOptions', () => {
  it('replaces, and writes the debounced text as fgSearch once the debounce has settled on it', () => {
    assert.deepEqual(searchNavigateOptions('alloc', 'alloc', ''), {
      replace: true,
      set: { fgSearch: 'alloc' },
    });
  });

  it('clears fgSearch once the debounced text empties out', () => {
    assert.deepEqual(searchNavigateOptions('', '', 'alloc'), {
      replace: true,
      set: { fgSearch: null },
    });
  });

  it('is a no-op once the debounced draft matches what is already committed', () => {
    // This is the guard that stops the write effect from looping on its own
    // commit: committing a value changes fgSearch, the edit buffer adopts it
    // as the new draft, and the debounce eventually settles back on the
    // same text.
    assert.equal(searchNavigateOptions('alloc', 'alloc', 'alloc'), undefined);
  });

  // The three cases below are the livelock/clobber walkthrough from the
  // review: `debounced` catching up to an external `draft` change is not
  // the same as the debounce having settled on a completed local edit, and
  // only the latter is safe to write.

  it('is a no-op for an external-commit echo: draft caught up to the new URL value, debounced has not', () => {
    // Comparison, pane B: pane A just committed "abc". B's edit buffer reset
    // its draft to "abc" (the new fgSearch), but B's own debounce is still
    // carrying the empty string it had mid-typing. Writing here would
    // immediately clear the fgSearch pane A just set.
    assert.equal(searchNavigateOptions('', 'abc', 'abc'), undefined);
  });

  it('is a no-op right after Back: draft reset to the entry navigated to, debounced still stale', () => {
    // Back lands on an entry with fgSearch="old". The edit buffer resets its
    // draft to "old", but the debounced value is still whatever was typed
    // before Back was pressed. Writing here would overwrite the entry the
    // user just navigated to.
    assert.equal(searchNavigateOptions('typed', 'old', 'old'), undefined);
  });

  it('writes once debounced and draft agree and differ from what is committed: a settled local edit', () => {
    assert.deepEqual(searchNavigateOptions('alloc', 'alloc', ''), {
      replace: true,
      set: { fgSearch: 'alloc' },
    });
  });
});
