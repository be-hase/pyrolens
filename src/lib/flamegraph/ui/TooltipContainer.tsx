import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cx } from '../cx';
import './TooltipContainer.css';

const VIEWPORT_MARGIN = 8;

/**
 * Floating panel that follows the cursor, replacing Grafana's
 * `VizTooltipContainer`. `position` is a viewport coordinate; `offset` pushes
 * the panel away from it, and the panel flips to the other side when it would
 * run off the screen.
 */
export function TooltipContainer({
  position,
  offset,
  className,
  children,
}: {
  position: { x: number; y: number };
  offset: { x: number; y: number };
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Measured and placed by mutating the node: the tooltip moves on every
  // mouse move, so an extra state-driven render per move is wasteful and
  // would show the panel at the unflipped spot for a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { width, height } = el.getBoundingClientRect();

    let x = position.x + offset.x;
    let y = position.y + offset.y;

    if (x + width > window.innerWidth - VIEWPORT_MARGIN) {
      x = position.x - offset.x - width;
    }
    if (y + height > window.innerHeight - VIEWPORT_MARGIN) {
      y = position.y - offset.y - height;
    }

    el.style.transform = `translate(${Math.max(
      VIEWPORT_MARGIN,
      x,
    )}px, ${Math.max(VIEWPORT_MARGIN, y)}px)`;
  });

  return (
    <div
      ref={ref}
      className={cx('plfg-tooltip-container', className)}
      style={{
        transform: `translate(${position.x + offset.x}px, ${
          position.y + offset.y
        }px)`,
      }}
    >
      {children}
    </div>
  );
}

export default TooltipContainer;
