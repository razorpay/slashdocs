import * as React from "react";
import { cn } from "@/lib/cn";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "input-glow h-9 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "input-glow min-h-[60px] w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

// Field names a control with a label above it, and ties its hint and its
// error to it, so that a screen reader reads them with the control.
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>;
}) {
  const id = React.useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean);
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-xs font-medium text-[var(--color-fg-muted)]"
      >
        {label}
      </label>
      {React.cloneElement(children, {
        id,
        "aria-describedby": described.join(" ") || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-[11px] text-[var(--color-fg-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
