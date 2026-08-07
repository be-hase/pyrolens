import type { CSSProperties } from 'react';
import './Icon.css';

export type IconType =
  | 'align-left'
  | 'align-right'
  | 'angle-double-down'
  | 'angle-double-up'
  | 'angle-down'
  | 'angle-left'
  | 'angle-right'
  | 'angle-up'
  | 'calendar'
  | 'check'
  | 'copy'
  | 'exclamation-circle'
  | 'eye'
  | 'history-alt'
  | 'logo'
  | 'moon'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'sandwich'
  | 'search'
  | 'sun'
  | 'times';

// Icons are rendered as a CSS mask over `currentColor`: the SVG contributes
// only its alpha channel, so every icon automatically takes the parent's
// text color in both themes.
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconType;
  size?: number;
  className?: string;
}) {
  const mask = `url(${import.meta.env.BASE_URL}icons/${name}.svg)`;
  const style: CSSProperties = {
    width: size,
    height: size,
    maskImage: mask,
    WebkitMaskImage: mask,
  };
  return (
    <span
      className={className ? `icon ${className}` : 'icon'}
      style={style}
      aria-hidden="true"
    />
  );
}
