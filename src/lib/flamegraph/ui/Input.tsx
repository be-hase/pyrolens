import type { ChangeEvent, ReactNode } from 'react';
import { cx } from '../cx';
import './Input.css';

export interface InputProps {
  value: string;
  /** Receives the native change event, as upstream's `Input` did. */
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  className?: string;
  'aria-label'?: string;
}

export function Input({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  className,
  'aria-label': ariaLabel,
}: InputProps) {
  return (
    <div className={cx('plfg-input', className)}>
      {prefix && <span className="plfg-input-prefix">{prefix}</span>}
      <input
        className="plfg-input-field"
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {suffix && <span className="plfg-input-suffix">{suffix}</span>}
    </div>
  );
}

export default Input;
