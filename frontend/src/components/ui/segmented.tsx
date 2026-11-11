import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

type Option<T> = { value: T; label: string };

const TRACK =
  "flex flex-wrap gap-0.5 rounded-sm bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] dark:ring-transparent";
const CHOICE =
  "relative flex h-8 flex-1 items-center justify-center whitespace-nowrap rounded-[6px] px-3 text-sm font-medium text-[var(--color-fg-muted)] transition-[color,transform] duration-150 ease-out active:scale-[0.97] aria-selected:text-[var(--color-fg)] aria-[current=page]:text-[var(--color-fg)]";
// The choice that each key moves to, from choice i of n. The arrows wrap.
export const STEPS: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i + n - 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

// The raised choice, which slides to the option that the reader picks.
function Face({ track, on, label }: { track: string; on: boolean; label: ReactNode }) {
  return (
    <>
      {on ? (
        <motion.span
          layoutId={track}
          transition={{ type: "spring", duration: 0.25, bounce: 0 }}
          className="absolute inset-0 rounded-[6px] bg-[var(--color-surface)] shadow-[var(--shadow-border)]"
        />
      ) : null}
      <span className="relative">{label}</span>
    </>
  );
}

// The props of the panel that the Segmented with this `panel` id controls.
export const tabPanel = (panel: string) =>
  ({ role: "tabpanel", id: panel, "aria-labelledby": `${panel}-tab` }) as const;

// A segmented control, as in Slash: the muted track holds a raised choice.
// It is a set of tabs with one tab stop. The arrow keys, Home and End move to
// a tab and pick it.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  panel,
  className,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  // The id of the panel that shows the picked choice, if there is one.
  panel?: string;
  className?: string;
}) {
  const track = useId();
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = step(current, options.length);
    onChange(options[next].value);
    event.currentTarget.querySelectorAll("button")[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(TRACK, className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          id={i === current && panel ? `${panel}-tab` : undefined}
          aria-selected={i === current}
          aria-controls={panel}
          tabIndex={i === current ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={CHOICE}
        >
          <Face track={track} on={i === current} label={o.label} />
        </button>
      ))}
    </div>
  );
}

// The same control as navigation between pages: each choice is a link, and
// the current page is marked.
export function SegmentedNav({
  label,
  value,
  options,
  className,
}: {
  label: string;
  value: string;
  options: Option<string>[];
  className?: string;
}) {
  const track = useId();
  return (
    <nav aria-label={label} className={cn(TRACK, className)}>
      {options.map((o) => (
        <Link
          key={o.value}
          to={o.value}
          aria-current={o.value === value ? "page" : undefined}
          className={CHOICE}
        >
          <Face track={track} on={o.value === value} label={o.label} />
        </Link>
      ))}
    </nav>
  );
}
