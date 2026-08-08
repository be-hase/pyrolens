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
  label,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Optional icon shown before the trigger label. */
  icon?: IconType;
  align?: 'left' | 'right';
  className?: string;
  /**
   * Names the control. Without it the trigger's only text is the current
   * value, so it announces as e.g. "Dark, collapsed" with nothing saying
   * what it selects.
   */
  label?: string;
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
        // Both halves: the visible text is only the value, so a bare
        // aria-label would trade "what it holds" for "what it is".
        aria-label={label && `${label}: ${current?.label ?? value}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
      </Button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        role="listbox"
        label={label}
      >
        {options.map((o) => (
          <Fragment key={o.value}>
            {o.divider && <div className="dropdown-divider" />}
            <button
              type="button"
              role="option"
              // The selected option is otherwise signalled by background
              // colour alone.
              aria-selected={o.value === value}
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
