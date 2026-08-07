import type { MouseEventHandler, ReactNode } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from './Icon';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
  icon?: IconName;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  title?: string;
  /** Alias for `title`, kept because upstream spelled it `tooltip`. */
  tooltip?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  onClick,
  children,
  className,
  'aria-label': ariaLabel,
  title,
  tooltip,
  disabled,
  type = 'button',
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'plfg-btn',
        `plfg-btn-${variant}`,
        `plfg-btn-${size}`,
        className,
      )}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? tooltip}
    >
      {icon && <Icon name={icon} size={size === 'md' ? 'md' : 'sm'} />}
      {children}
    </button>
  );
}

/** Row of buttons rendered as one segmented control. */
export function ButtonGroup({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx('plfg-button-group', className)}>{children}</div>;
}

export default Button;
