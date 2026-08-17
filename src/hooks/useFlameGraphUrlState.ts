import { useEffect } from 'react';
import { navigate, useRoute, type NavigateOptions } from '../urlState';
import { useDebouncedValue } from './useDebouncedValue';
import { useEditBuffer } from './useEditBuffer';

// Trailing debounce before a typed search commits to the URL. Long enough
// that a burst of keystrokes writes once, short enough that a pause reads as
// "done typing" rather than stuck.
const SEARCH_DEBOUNCE_MS = 400;

// The URL<->prop mapping below is pulled out of the hook and exported so it
// can be unit tested directly. The vendored flame graph needs a real canvas
// context to mount without throwing, which jsdom does not provide (see
// AGENTS.md's "Verifying a change" section), so FlameGraph.test.tsx
// exercises these functions rather than rendering a component tree.

/** Reads the shared search/sandwich URL params. */
export function flameGraphUrlState(params: URLSearchParams): {
  search: string;
  sandwichItem: string | undefined;
} {
  return {
    search: params.get('fgSearch') ?? '',
    sandwichItem: params.get('fgSandwich') ?? undefined,
  };
}

/**
 * navigate() options for a sandwich change. Always `replace`: a sandwich
 * toggle isn't a history-worthy step on its own — Back should step through
 * meaningful states, not every click in and out of a sandwich view.
 */
export function sandwichNavigateOptions(
  item: string | undefined,
): NavigateOptions {
  return { replace: true, set: { fgSandwich: item || null } };
}

/**
 * navigate() options for a debounced search write, or undefined when there
 * is nothing to write.
 *
 * The write is only valid when `debounced` has actually settled on the
 * CURRENT draft (`debounced === draft`) — otherwise it is a stale echo of an
 * external change still working its way through this debounce, not a
 * completed local edit. Two symptoms motivated this: in Comparison, typing
 * in one pane commits fgSearch, the other pane's edit buffer resets its
 * draft to the new value, but its `useDebouncedValue` state is still the old
 * text for one more tick — writing then would immediately delete what the
 * first pane just committed, and the first pane's effect would restore it,
 * ping-ponging forever. In a single view, pressing Back to an entry with a
 * different fgSearch has the same shape: the stale debounced value would
 * instantly overwrite the entry just navigated to. Once `debounced` catches
 * up to `draft` (both hooks settle on the same value), it is safe to compare
 * against `committed` and decide whether there is anything left to write.
 */
export function searchNavigateOptions(
  debounced: string,
  draft: string,
  committed: string,
): NavigateOptions | undefined {
  if (debounced !== draft) return undefined;
  if (debounced === committed) return undefined;
  return { replace: true, set: { fgSearch: debounced || null } };
}

/**
 * URL wiring shared by every controlled flame graph on screen: the
 * fgSearch/fgSandwich params are read straight off the URL rather than
 * threaded in as props from a parent, on purpose — every flame graph shares
 * the same two params (not side-prefixed per pane), so typing a search in
 * one Comparison pane highlights the same symbols in the other, and the Diff
 * view's single flame graph honours a deep-linked fgSearch/fgSandwich the
 * same as Single and Comparison do.
 */
export function useFlameGraphUrlState(): {
  search: string;
  onSearchChange: (search: string) => void;
  sandwichItem: string | undefined;
  onSandwichChange: (item: string | undefined) => void;
} {
  const { params } = useRoute();
  const { search: fgSearch, sandwichItem: fgSandwich } =
    flameGraphUrlState(params);

  // Typing must not navigate on every keystroke, so the search box is an
  // edit buffer anchored to the committed fgSearch URL value — same
  // discipline as the query bar (see useEditBuffer). onSearchChange updates
  // this immediately, so highlighting inside the flame graph stays
  // keystroke-fast even though the URL write below is debounced.
  const [searchDraft, setSearchDraft] = useEditBuffer(fgSearch);
  // Debounced trailing write. fgSearch is a view-only param (see
  // VIEW_ONLY_PARAMS in urlState.ts), so its write no longer advances the
  // frozen "now" or refires fetches — but per-keystroke writes would still
  // flood the history's replace budget and re-render every URL subscriber,
  // so the debounce stays. useDebouncedValue's own effect cleanup cancels
  // the pending write on unmount and restarts it whenever the draft changes
  // again, including when it changes back to what's already committed.
  const debouncedSearch = useDebouncedValue(searchDraft, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    const opts = searchNavigateOptions(debouncedSearch, searchDraft, fgSearch);
    if (opts) navigate(opts);
  }, [debouncedSearch, searchDraft, fgSearch]);

  return {
    search: searchDraft,
    onSearchChange: setSearchDraft,
    sandwichItem: fgSandwich,
    onSandwichChange: (item) => navigate(sandwichNavigateOptions(item)),
  };
}
