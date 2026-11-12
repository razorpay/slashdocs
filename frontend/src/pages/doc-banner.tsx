import type { LucideIcon } from "lucide-react";

// DocBanner is the full-width bar at the top of the document that says what
// the reader looks at, with the actions for it. It takes its own room above
// the document, also in full screen, so it covers no text. A screen reader
// reads it once, when it shows.
export function DocBanner({
  icon: Icon,
  actions,
  children,
}: {
  icon: LucideIcon;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      // Narrow screens put the actions under the message.
      className="enter flex flex-col gap-2 border-b border-[var(--color-accent)]/30 bg-[var(--color-accent-muted)] px-3 py-2 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:gap-3"
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
