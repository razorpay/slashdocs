import { History } from "lucide-react";
import type { Version } from "@/api";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/cn";
import { useDoc } from "./doc-context";
import { RestoreButton } from "./doc-history";

// A reader who previews an earlier entry of the history (a shared ?version=
// link, the History dialog, or a held comment draft) must not mistake it for
// the current document.
export function PreviewBanner({
  docId,
  version,
  canRestore,
  floating,
}: {
  docId: string;
  // The previewed entry, once the history has loaded.
  version?: Version;
  canRestore: boolean;
  // In full screen there is no doc bar, so the banner floats over the document.
  floating?: boolean;
}) {
  const { showLatest } = useDoc();
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
        floating
          ? "absolute bottom-6 left-1/2 z-20 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border shadow-xl"
          : "border-b",
      )}
    >
      <History className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {version?.created_at ? (
          <>
            This is the document as it was <RelativeTime iso={version.created_at} />.
          </>
        ) : (
          "This is an earlier state of the document."
        )}
      </p>
      {canRestore ? <RestoreButton docId={docId} version={version} /> : null}
      <Button size="sm" variant="outline" className="shrink-0" onClick={showLatest}>
        Back to the current document
      </Button>
    </div>
  );
}
