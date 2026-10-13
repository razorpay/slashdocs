import { History } from "lucide-react";
import type { Version } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format-date";

// A reader pinned to an older version (a shared ?version= link, the history
// dialog, or a held comment draft) must not mistake it for the current doc.
export function OlderVersionBanner({
  current,
  latest,
  versions,
  onViewLatest,
  className,
}: {
  current: string;
  latest: string;
  versions: Version[];
  onViewLatest: () => void;
  className?: string;
}) {
  if (!current || !latest || current === latest) return null;
  const viewing = versions.find((v) => v.id === current);
  const newest = versions.find((v) => v.id === latest);
  const published = formatTimestamp(viewing?.created_at);
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
        className,
      )}
    >
      <History className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {viewing ? (
          <>
            You're viewing an older version (v{viewing.number}
            {published ? `, published ${published}` : ""}).
            {newest ? ` The latest is v${newest.number}.` : ""}
          </>
        ) : (
          "You're viewing an older version of this document."
        )}
      </p>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onViewLatest}>
        View latest
      </Button>
    </div>
  );
}
