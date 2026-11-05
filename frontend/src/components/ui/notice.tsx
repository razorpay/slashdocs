import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// Notice sits in a form and tells of a change to the words that the reader
// writes there: someone else changed them, their place is gone, or they came
// back from an earlier visit. It shows the words that it is about, and offers
// what to do. The reader's own words stay in the field until they choose.
export function Notice({
  say,
  quotes = [],
  className,
  children,
}: {
  say: string;
  quotes?: ReactNode[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-2 rounded-md bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs text-[var(--color-fg-muted)]",
        className,
      )}
    >
      {say}
      {quotes.map((quote, i) => (
        <div key={i} className="mt-1 text-[var(--color-fg)]">
          {quote}
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-x-3">{children}</div>
    </div>
  );
}

export function NoticeAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto p-0 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
