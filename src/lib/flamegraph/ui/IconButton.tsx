import type { MouseEventHandler } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from './Icon';
import './IconButton.css';

export interface IconButtonProps {
  name: IconName;
  size?: 'sm' | 'md';
  /** Rendered as the native `title` attribute. */
  tooltip?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  variant?: 'primary' | 'secondary';
  'aria-label'?: string;
  disabled?: boolean;
}

export function IconButton({
  name,
  size = 'md',
  tooltip,
  onClick,
  className,
  variant = 'secondary',
  'aria-label': ariaLabel,
  disabled,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'plfg-icon-btn',
        `plfg-icon-btn-${size}`,
        `plfg-icon-btn-${variant}`,
        className,
      )}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      aria-label={ariaLabel ?? tooltip}
    >
      <Icon name={name} size={size} />
    </button>
  );
}

export default IconButton;
