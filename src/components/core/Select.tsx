import { Fragment, useState } from 'react';
import { Button } from './Button';
import { Dropdown } from './Dropdown';
import type { IconType } from './Icon';
import './Select.css';

export interface SelectOption {
  label: string;
  value: string;
  /** Draw a separator line above this option. */
  divider?: boolean;
}

// Single-level picker: a button showing the current option's label, with a
// popup list of options (time-range presets, theme, ...).
export function Select({
  value,
  options,
  onChange,
  icon,
  align = 'left',
  className,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Optional icon shown before the trigger label. */
  icon?: IconType;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <div className={className ? `select ${className}` : 'select'}>
      <Button
        icon={icon}
        iconRight="angle-down"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
      </Button>
      <Dropdown open={open} onClose={() => setOpen(false)} align={align}>
        {options.map((o) => (
          <Fragment key={o.value}>
            {o.divider && <div className="dropdown-divider" />}
            <button
              type="button"
              className={
                o.value === value ? 'select-option active' : 'select-option'
              }
              onClick={() => {
                setOpen(false);
                onChange(o.value);
              }}
            >
              {o.label}
            </button>
          </Fragment>
        ))}
      </Dropdown>
    </div>
  );
}
