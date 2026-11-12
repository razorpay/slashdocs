import { cn } from "@/lib/cn";

// A segmented control, as in Slash: the muted track holds a raised choice.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex flex-wrap gap-0.5 rounded-sm bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] dark:ring-transparent",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className="h-8 flex-1 whitespace-nowrap rounded-[6px] px-3 text-sm font-medium text-[var(--color-fg-muted)] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] aria-selected:bg-[var(--color-surface)] aria-selected:text-[var(--color-fg)] aria-selected:shadow-[var(--shadow-border)]"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
