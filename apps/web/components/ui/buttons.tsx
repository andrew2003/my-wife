import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "default" | "primary" | "accent" | "danger" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({
  variant = "default",
  loading = false,
  className,
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      className={cx("mw-button", variant !== "default" && `mw-button-${variant}`, className)}
    >
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  /** Accessible name; required because the content is an icon. */
  label: string;
  children: ReactNode;
}

export function IconButton({
  label,
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button {...rest} type={type} aria-label={label} className={cx("mw-icon-button", className)}>
      {children}
    </button>
  );
}

export interface ChipProps {
  tone?: "neutral" | "success" | "warning" | "danger";
  /** When set the chip is a button and gets the touch size. */
  onClick?: () => void;
  children: ReactNode;
}

export function Chip({ tone = "neutral", onClick, children }: ChipProps) {
  const toneClass = tone !== "neutral" && `mw-chip-${tone}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cx("mw-chip-button", toneClass)}>
        {children}
      </button>
    );
  }
  return <span className={cx("mw-chip", toneClass)}>{children}</span>;
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

export interface SegmentedControlProps {
  /** Accessible group name. */
  label: string;
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
}

export function SegmentedControl({ label, value, options, onChange }: SegmentedControlProps) {
  return (
    <div role="group" aria-label={label} className="mw-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="mw-segmented-item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
