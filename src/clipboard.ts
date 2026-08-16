// `navigator.clipboard` only exists in a secure context (HTTPS or
// localhost); Pyrolens is commonly deployed over plain HTTP as an internal
// tool, where it is `undefined` and calling `.writeText` throws
// synchronously. Fall back to the classic hidden-textarea + `execCommand`
// path, and never let a rejection/throw escape uncaught.
//
// A near-identical helper lives inside the vendored
// `src/lib/flamegraph/FlameGraph/FlameGraphContextMenu.tsx`. It is not
// imported from here on purpose — the vendored tree stays self-contained, so
// this small duplication is deliberate rather than an oversight.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below (e.g. permission denied).
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it out of the visible layout and off-screen so it never flashes.
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
