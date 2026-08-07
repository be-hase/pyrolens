import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconType } from './Icon';
import './Button.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
  /** Icon rendered before the label. */
  icon?: IconType;
  /** Icon rendered after the label (e.g. a chevron). */
  iconRight?: IconType;
}

export function Button({
  variant = 'default',
  icon,
  iconRight,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = ['btn', variant === 'primary' && 'btn-primary', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children}
      {iconRight && <Icon name={iconRight} size={14} />}
    </button>
  );
}
