import { useSyncExternalStore } from 'react';

/**
 * The slice of Grafana's `GrafanaTheme2` the flame graph actually reasons
 * about. Everything else upstream used the theme for lived in emotion blocks,
 * which are plain `.css` files here; these two values are read in JS because
 * they drive canvas painting and colour-scheme decisions.
 */
export interface Theme {
  isLight: boolean;
  colors: {
    background: { primary: string; secondary: string };
    text: { primary: string; secondary: string; disabled: string };
  };
}

const FALLBACK_DARK: Theme = {
  isLight: false,
  colors: {
    background: { primary: '#1a1d23', secondary: '#242933' },
    text: { primary: '#d9dce3', secondary: '#8d94a3', disabled: '#5b6272' },
  },
};

/**
 * Non-hook variant, for module-level defaults and non-reactive call sites.
 * Resolves our design tokens off `<html>` so the values always match whatever
 * `src/theme.css` currently defines.
 */
export function getTheme(): Theme {
  if (typeof document === 'undefined') {
    return FALLBACK_DARK;
  }

  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const read = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback;

  return {
    isLight: root.dataset.theme === 'light',
    colors: {
      background: {
        primary: read('--bg-primary', FALLBACK_DARK.colors.background.primary),
        secondary: read(
          '--bg-secondary',
          FALLBACK_DARK.colors.background.secondary,
        ),
      },
      text: {
        primary: read('--text-primary', FALLBACK_DARK.colors.text.primary),
        secondary: read(
          '--text-secondary',
          FALLBACK_DARK.colors.text.secondary,
        ),
        disabled: read('--text-muted', FALLBACK_DARK.colors.text.disabled),
      },
    },
  };
}

/**
 * Snapshot cache. `useSyncExternalStore` requires a stable reference between
 * renders, so the theme object is only rebuilt when `data-theme` actually
 * changes.
 */
let snapshot: Theme | undefined;

function getSnapshot(): Theme {
  snapshot ??= getTheme();
  return snapshot;
}

/** Replaces the cached snapshot only when something actually changed, so
 * subscribers of an unchanged theme keep their identical reference. */
function refresh(): boolean {
  const next = getTheme();
  const prev = snapshot;
  if (
    prev &&
    prev.isLight === next.isLight &&
    prev.colors.background.primary === next.colors.background.primary &&
    prev.colors.background.secondary === next.colors.background.secondary &&
    prev.colors.text.primary === next.colors.text.primary &&
    prev.colors.text.secondary === next.colors.text.secondary &&
    prev.colors.text.disabled === next.colors.text.disabled
  ) {
    return false;
  }
  snapshot = next;
  return true;
}

// One observer for every subscriber. Per-subscriber observers each called
// refresh(), and refresh() reports a change only once — so whichever
// callback ran first repainted and all the others were never told, leaving
// half the flame graph on the previous theme until something unrelated
// re-rendered it.
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(onChange: () => void): () => void {
  // The attribute may have flipped between render and subscription; React
  // re-reads the snapshot right after subscribing, so refresh it here.
  refresh();
  listeners.add(onChange);

  if (!observer) {
    observer = new MutationObserver(() => {
      if (!refresh()) return;
      for (const listener of [...listeners]) listener();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

/**
 * Reads the theme and re-renders when the app flips `<html data-theme>`.
 * Same MutationObserver trick `src/components/TimeSeries.tsx` uses, because
 * colours resolved in JS don't react to CSS variables on their own.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot);
}
