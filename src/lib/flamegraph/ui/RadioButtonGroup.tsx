import { cx } from '../cx';
import { Icon, type IconName } from './Icon';
import './RadioButtonGroup.css';

export interface RadioOption<T extends string> {
  /** Optional so icon-only options (the text-align switch) can omit it. */
  label?: string;
  value: T;
  description?: string;
  icon?: IconName;
}

export interface RadioButtonGroupProps<T extends string> {
  options: Array<RadioOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}

/** Segmented control — Top Table / Flame Graph / Both, text alignment, etc. */
export function RadioButtonGroup<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
  className,
  disabled,
}: RadioButtonGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cx(
        'plfg-radio-group',
        disabled && 'plfg-radio-group-disabled',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label ?? option.description}
            title={option.description}
            disabled={disabled}
            className={cx(
              'plfg-radio-btn',
              `plfg-radio-btn-${size}`,
              active && 'plfg-radio-btn-active',
            )}
            onClick={() => {
              if (!active) {
                onChange(option.value);
              }
            }}
          >
            {option.icon && <Icon name={option.icon} size={size} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default RadioButtonGroup;
