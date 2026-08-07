import type { ReactNode } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from './Icon';
import './Menu.css';

export interface MenuItemProps {
  label: string;
  icon?: IconName;
  onClick?: () => void;
  ariaLabel?: string;
  active?: boolean;
  disabled?: boolean;
}

export function MenuItem({
  label,
  icon,
  onClick,
  ariaLabel,
  active,
  disabled,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx('plfg-menu-item', active && 'plfg-menu-item-active')}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size="sm" />}
      {label}
    </button>
  );
}

export function MenuGroup({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="plfg-menu-group" role="group" aria-label={label}>
      {label && <div className="plfg-menu-group-label">{label}</div>}
      {children}
    </div>
  );
}

interface MenuComponent {
  (props: { className?: string; children: ReactNode }): ReactNode;
  Item: typeof MenuItem;
  Group: typeof MenuGroup;
}

function MenuBase({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('plfg-menu', className)} role="menu">
      {children}
    </div>
  );
}

/**
 * `Menu.Item` / `Menu.Group` are aliases of the named exports, so both the
 * upstream call style and plain `<MenuItem />` work.
 */
export const Menu = MenuBase as MenuComponent;
Menu.Item = MenuItem;
Menu.Group = MenuGroup;

export default Menu;
