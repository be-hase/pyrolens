import { useEffect, useRef, type ReactNode } from 'react';
import './Dropdown.css';

// Open dropdowns, outermost first. Escape only closes the most recently
// opened one, so a nested popup (e.g. the calendar inside the time range
// picker) doesn't take its parent down with it.
const escapeStack: object[] = [];

// Generic anchored popup panel. Render it inside a `position: relative`
// wrapper that also contains the trigger button; pointer-downs on anything
// inside that wrapper (including the trigger) are treated as "inside", so
// the trigger's own onClick can toggle without racing the close handler.
// Closes on outside pointer-down and on Escape.
export function Dropdown({
  open,
  onClose,
  align = 'left',
  className,
  role,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  className?: string;
  /** Matches the trigger's aria-haspopup, so the promise it makes is kept. */
  role?: 'listbox' | 'menu' | 'dialog';
  /** Accessible name, for the roles that need one. */
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Kept in a ref so the open/close effect depends only on `open`: owner
  // re-renders (inline onClose closures) must not re-push the escape-stack
  // token, or the innermost-dropdown ordering breaks.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const token = {};
    escapeStack.push(token);
    const onPointerDown = (e: MouseEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeStack.at(-1) === token) {
        onCloseRef.current();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      escapeStack.splice(escapeStack.indexOf(token), 1);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`dropdown dropdown-${align}${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={label}
    >
      {children}
    </div>
  );
}
