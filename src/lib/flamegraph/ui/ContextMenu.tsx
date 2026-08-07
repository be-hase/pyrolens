import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Menu } from './Menu';
import { Portal } from './Portal';
import './ContextMenu.css';

const VIEWPORT_MARGIN = 8;

/**
 * Right-click menu pinned to a viewport coordinate. Flips left/up when it
 * would overflow, and closes on outside click or Escape.
 *
 * `renderMenuItems` returns bare `MenuItem`/`MenuGroup` nodes; the surrounding
 * `Menu` panel is supplied here, as Grafana's ContextMenu did.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  renderMenuItems,
}: {
  x: number;
  y: number;
  onClose: () => void;
  renderMenuItems: () => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Positioned by mutating the node: measuring first and then re-rendering
  // would make the menu visibly jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { width, height } = el.getBoundingClientRect();

    let left = x;
    let top = y;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
      left = left - width;
    }
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      top = top - height;
    }

    el.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    el.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Deferred so the click that opened the menu doesn't close it again.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
    }, 0);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <Portal>
      <div
        ref={ref}
        className="plfg-context-menu"
        style={{ left: x, top: y }}
        onClick={onClose}
      >
        <Menu>{renderMenuItems()}</Menu>
      </div>
    </Portal>
  );
}

export default ContextMenu;
