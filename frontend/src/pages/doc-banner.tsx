import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

// DocBanner is the full-width bar at the top of the document that says what
// the reader looks at, with the actions for it. A screen reader reads it
// once, when it shows.
export function DocBanner({
  icon: Icon,
  floating,
  actions,
  children,
}: {
  icon: LucideIcon;
  // In full screen there is no doc bar, so the banner floats over the document.
  floating?: boolean;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        // Narrow screens put the actions under the message.
        "enter flex flex-col gap-2 border-[var(--color-accent)]/30 bg-[var(--color-accent-muted)] px-3 py-2 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:gap-3",
        floating
          ? "absolute bottom-6 left-1/2 z-20 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border shadow-xl"
          : "border-b",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Icon
          className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
          aria-hidden="true"
        />
        <p className="min-w-0 text-pretty">{children}</p>
      </div>
      <div className="flex shrink-0 justify-end gap-2">{actions}</div>
    </div>
  );
}
