import type { ReactNode } from "react";
import { Button, IconButton } from "./buttons";
import { cx } from "./cx";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("mw-card", className)}>{children}</div>;
}

export interface StatTileProps {
  label: string;
  /** Already formatted for the locale; rendered with tabular figures. */
  value: string;
  hint?: string;
}

export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <Card className="mw-stat">
      <span className="mw-stat-label">{label}</span>
      <span className="mw-stat-value">{value}</span>
      {hint ? <span className="mw-hint">{hint}</span> : null}
    </Card>
  );
}

export interface ProgressBarProps {
  /** Percentage, clamped to 0..100. */
  value: number;
  label: string;
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    <div className="mw-progress">
      <span className="mw-label">{label}</span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mw-progress-track"
      >
        <div className="mw-progress-bar" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}

export interface ResponsiveTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export interface ResponsiveTableProps<T> {
  caption: string;
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
}

export function ResponsiveTable<T>({ caption, columns, rows, rowKey }: ResponsiveTableProps<T>) {
  return (
    <table className="mw-table">
      <caption className="mw-label">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td key={c.key} data-label={c.header}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ToastProps {
  tone?: "info" | "success" | "danger";
  dismissLabel?: string;
  onDismiss?: () => void;
  children: ReactNode;
}

export function Toast({ tone = "info", dismissLabel, onDismiss, children }: ToastProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("mw-toast", tone !== "info" && `mw-toast-${tone}`)}
    >
      <span>{children}</span>
      {onDismiss && dismissLabel ? (
        <IconButton label={dismissLabel} onClick={onDismiss}>
          <span aria-hidden="true">×</span>
        </IconButton>
      ) : null}
    </div>
  );
}

/** Placeholder block; `label` is the accessible loading text. */
export function Skeleton({
  label,
  height,
  className,
}: {
  label: string;
  height?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cx("mw-skeleton", className)}
      style={height ? { height } : undefined}
    />
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional art or illustration slot. */
  art?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ title, description, art, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="mw-state mw-state-empty">
      {art}
      <h2 className="mw-state-title">{title}</h2>
      {description ? <p className="mw-hint">{description}</p> : null}
      {actionLabel && onAction ? (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  description?: string;
  art?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
}

export function ErrorState({ title, description, art, retryLabel, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="mw-state mw-state-error">
      {art}
      <h2 className="mw-state-title">{title}</h2>
      {description ? <p className="mw-hint">{description}</p> : null}
      {retryLabel && onRetry ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  );
}
