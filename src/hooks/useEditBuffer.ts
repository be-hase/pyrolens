import { useState } from 'react';

/**
 * A local edit buffer over a value that lives in the URL.
 *
 * Typing must not navigate — the query bar only writes to the URL on Run — so
 * the edited text is held here. When the URL value changes underneath (Back,
 * a link, another control writing the same param), the buffer is dropped and
 * the URL wins again: the alternative is a stale draft quietly overriding
 * what the address bar says.
 *
 * The reset happens during render rather than in an effect, per
 * https://react.dev/learn/you-might-not-need-an-effect, and returns the
 * adjusted value directly rather than leaning on the re-render that setting
 * state during render triggers. React discards that render either way, so the
 * difference is one wasted pass and nothing a test can observe.
 */
export function useEditBuffer(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState<string | null>(null);
  const [previous, setPrevious] = useState(value);

  if (previous !== value) {
    setPrevious(value);
    setDraft(null);
    return [value, setDraft];
  }

  return [draft ?? value, setDraft];
}
