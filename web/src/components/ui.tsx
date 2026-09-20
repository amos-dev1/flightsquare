import type { ComponentProps, ReactNode } from 'react';

/**
 * Copy-in components, owned outright: no component-library runtime, nothing
 * to theme around, and the post-flight form (§3.4) stays hand-tunable — it is
 * the screen the whole product depends on, and it has to be fast to fill in
 * on a phone at a tiedown.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-white shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-accent text-white hover:opacity-90',
    secondary: 'border border-line bg-white text-ink hover:bg-surface',
    danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium transition disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`}
    />
  );
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={`h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`}
    />
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      {children}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

/** A meter value, or an honest dash when nothing has been read yet. */
export function Meter({ value, unit = 'hrs' }: { value: string | null; unit?: string }) {
  if (value === null) return <span className="text-muted">—</span>;
  return (
    <span className="tabular">
      {value}
      <span className="ml-1 text-xs text-muted">{unit}</span>
    </span>
  );
}
