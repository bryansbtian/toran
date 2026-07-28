// SPDX-License-Identifier: MIT
import type { ButtonHTMLAttributes, HTMLAttributes, JSX, ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Shared visual primitives.
 *
 * Every interactive element carries a visible focus ring and meets WCAG AA
 * contrast in both themes; motion is suppressed under `prefers-reduced-motion`
 * by the global stylesheet rather than per component.
 */

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
  readonly children: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary:
    'bg-surface-raised text-ink border border-line hover:bg-surface-sunken disabled:opacity-50',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-50',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 disabled:bg-danger-600/50',
};

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
        'text-sm font-medium transition-colors disabled:cursor-not-allowed',
        FOCUS_RING,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { readonly className?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
}

export function Card({ className, children, ...rest }: CardProps): JSX.Element {
  return (
    <div
      className={clsx(
        'rounded-xl border border-line bg-surface-raised p-6 shadow-sm sm:p-8',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<StatusTone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted border-line',
  success: 'bg-success-50 text-success-800 border-success-200',
  warning: 'bg-warning-50 text-warning-800 border-warning-200',
  danger: 'bg-danger-50 text-danger-800 border-danger-200',
  info: 'bg-brand-50 text-brand-800 border-brand-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        'text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Announces errors to assistive technology. `role="alert"` makes screen
 * readers interrupt; that is correct for a failed action the user just took.
 */
export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  readonly tone?: StatusTone;
  readonly title?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx('rounded-lg border px-4 py-3 text-sm', TONES[tone])}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClassName = clsx(
  'block w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink',
  'placeholder:text-ink-subtle',
  FOCUS_RING,
);

export function ProgressBar({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-[width] duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Visually hidden but available to screen readers. */
export function VisuallyHidden({ children }: { readonly children: ReactNode }): JSX.Element {
  return <span className="sr-only">{children}</span>;
}
