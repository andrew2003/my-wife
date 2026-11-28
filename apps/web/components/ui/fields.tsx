import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";

interface FieldChrome {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function Field({ id, label, hint, error, children }: FieldChrome & { children: ReactNode }) {
  return (
    <div className="mw-field">
      <label htmlFor={id} className="mw-label">
        {label}
      </label>
      {children}
      {hint ? (
        <span id={`${id}-hint`} className="mw-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="mw-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type InputProps = FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, "id">;

export function Input({ id, label, hint, error, className, ...rest }: InputProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={id}
        className={cx("mw-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
    </Field>
  );
}

export type TextareaProps = FieldChrome & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">;

export function Textarea({ id, label, hint, error, className, ...rest }: TextareaProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={id}
        className={cx("mw-textarea", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export type SelectProps = FieldChrome &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> & { options: SelectOption[] };

export function Select({ id, label, hint, error, options, className, ...rest }: SelectProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <select
        {...rest}
        id={id}
        className={cx("mw-select", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, checked, onChange, disabled }: ToggleProps) {
  return (
    <label className="mw-toggle">
      <span className="mw-toggle-track">
        <input
          type="checkbox"
          role="switch"
          className="mw-toggle-input"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="mw-toggle-thumb" aria-hidden="true" />
      </span>
      <span>{label}</span>
    </label>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export function Checkbox({ label, ...rest }: CheckboxProps) {
  return (
    <label className="mw-check">
      <input {...rest} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}
