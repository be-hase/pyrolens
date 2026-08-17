// Merely accessing `window.localStorage` — not just calling getItem/setItem
// on it — throws SecurityError under some browser storage settings
// (Chromium's "Block all cookies", some locked-down/embedded contexts). App
// used to read it directly from a useState initializer on its very first
// render, above the only ErrorBoundary in the tree, so the throw unmounted
// the whole app instead of just losing the remembered theme/tenant. These
// wrappers make that failure mode "not remembered" everywhere localStorage
// is touched.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort; nothing to recover from a blocked store.
  }
}
