import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RowState } from "./book-chapter-state";

// Each chapter state has its own shape, so it reads without colour (R13):
// an empty ring, a half-filled ring, a solid dot, a check, a dashed ring.
const SHAPE: Record<RowState, string> = {
  not_started: "ring",
  reading: "half",
  read: "solid",
  done: "check",
  planned: "dashed",
};

const STYLE: Record<RowState, string> = {
  not_started: "border-[1.5px] border-[var(--color-fg-muted)]",
  reading:
    "border-[1.5px] border-[var(--color-accent)] bg-[linear-gradient(90deg,var(--color-accent)_50%,transparent_50%)]",
  read: "bg-[var(--color-fg-muted)]",
  done: "bg-[var(--color-success)] text-white",
  planned: "border-[1.5px] border-dashed border-[var(--color-fg-muted)]",
};

export function StateDot({
  state,
  updated = false,
  className,
}: {
  state: RowState;
  // A small badge for a chapter with a version the reader has not seen.
  updated?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-shape={SHAPE[state]}
      className={cn(
        "relative inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full",
        STYLE[state],
        className,
      )}
    >
      {state === "done" ? <Check strokeWidth={4} className="h-[7px] w-[7px]" /> : null}
      {updated ? (
        <span
          data-shape="updated"
          className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-warning)] ring-1 ring-[var(--color-chrome)]"
        />
      ) : null}
    </span>
  );
}
