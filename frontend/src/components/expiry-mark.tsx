import { Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMinuteClock } from "@/components/ui/relative-time";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { DAY, formatTimestamp, formatUntil, formatUntilShort } from "@/lib/format-date";

// ExpiryMark shows that a document is deleted at a time: "Deletes in 3 days".
// A list gets the short form, "3 days". The tooltip gives the exact time, and
// so does the name for assistive tech. The mark turns to the warning color for
// the last day. With iconOnly it is the icon alone, for a bar with no room
// for the words. With onOpen it is a button, which the owner uses to change
// the expiry. The mark does not depend on whether the server deletes now: a
// document keeps its expiry, and its delete is pending, while the server has
// the feature off.
export function ExpiryMark({
  expiresAt,
  compact = false,
  iconOnly = false,
  className,
  onOpen,
}: {
  expiresAt?: string;
  compact?: boolean;
  iconOnly?: boolean;
  className?: string;
  onOpen?: () => void;
}) {
  const clock = useMinuteClock();
  if (!expiresAt) return null;
  const now = Math.max(clock, Date.now());
  const until = formatUntil(expiresAt, now);
  if (!until) return null;
  const full = `Deletes ${until}`;
  const exact = `This document is deleted on ${formatTimestamp(expiresAt)}.`;
  const label = `${full}. ${exact}`;
  const urgent = Date.parse(expiresAt) - now < DAY;
  const color = urgent ? "text-[var(--color-warning)]" : "text-[var(--color-fg-muted)]";
  const content = (
    <>
      <Timer
        aria-hidden="true"
        className={cn("shrink-0", iconOnly ? "size-4" : "size-3.5")}
      />
      {iconOnly ? null : (
        <span className="whitespace-nowrap">
          {compact ? formatUntilShort(expiresAt, now) : full}
        </span>
      )}
    </>
  );
  if (onOpen)
    return (
      <Button
        variant="chrome"
        size={iconOnly ? "icon-sm" : "sm"}
        onClick={onOpen}
        aria-label={label}
        tooltip={exact}
        className={cn(
          "shrink-0",
          !iconOnly && "gap-1.5 px-2 text-xs touch:h-10",
          color,
          className,
        )}
      >
        {content}
      </Button>
    );
  return (
    <Tooltip label={exact}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 cursor-default items-center gap-1 text-xs font-normal",
          iconOnly && "size-8 justify-center touch:size-10",
          color,
          className,
        )}
      >
        {content}
      </span>
    </Tooltip>
  );
}
