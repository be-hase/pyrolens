import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import './Dropdown.css';

const VIEWPORT_MARGIN = 8;

/**
 * Anchored popup. `children` is the trigger (clicking it toggles the popup),
 * `overlay` is the panel — usually a `<Menu>`. Closes on outside click, on
 * Escape, and on any click inside the overlay (menu items act and dismiss).
 */
export function Dropdown({
  overlay,
  children,
}: {
  overlay: ReactElement;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const anchor = anchorRef.current;
      if (anchor && !anchor.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Flip to right-aligned when a left-aligned panel would run off screen.
  // Done by mutating the node rather than via state so opening stays a single
  // render.
  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    el.classList.toggle(
      'plfg-dropdown-overlay-right',
      rect.right > window.innerWidth - VIEWPORT_MARGIN,
    );
  }, [open]);

  return (
    <div className="plfg-dropdown" ref={anchorRef}>
      <div
        className="plfg-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        {children}
      </div>
      {open && (
        <div
          ref={overlayRef}
          className="plfg-dropdown-overlay plfg-dropdown-overlay-left"
          onClick={close}
        >
          {overlay}
        </div>
      )}
    </div>
  );
}

export default Dropdown;
