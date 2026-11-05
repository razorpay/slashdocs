import { History } from "lucide-react";
import type { Version } from "@/api";
import { Button } from "@/components/ui/button";
import { RetryButton } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/cn";
import { loadFailed } from "@/lib/query-retry";
import { useDoc } from "./doc-context";
import { RestoreButton } from "./doc-history";
import { useVersions } from "./use-versions";

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
  // The entry, with its date and Restore, comes from the history. When the
  // history did not load, the banner says so, with Retry.
  const versions = useVersions(docId);
  const failed = !version && loadFailed(versions);
  return (
    <div
      role="status"
      className={cn(
        // Narrow screens put the actions under the message.
        "flex flex-col gap-2 border-[var(--color-accent)]/30 bg-[var(--color-accent-muted)] px-3 py-2 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:gap-3",
        floating
          ? "absolute bottom-6 left-1/2 z-20 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border shadow-xl"
          : "border-b",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <History
          className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
          aria-hidden="true"
        />
        <p className="min-w-0 text-pretty">
          {version?.created_at ? (
            <>
              This is the document as it was <RelativeTime iso={version.created_at} />.
            </>
          ) : failed ? (
            "This is an earlier state of the document. The history did not load."
          ) : (
            "This is an earlier state of the document."
          )}
        </p>
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        {failed ? (
          <RetryButton query={versions} size="sm" variant="outline" />
        ) : canRestore ? (
          <RestoreButton docId={docId} version={version} />
        ) : null}
        <Button size="sm" variant="outline" onClick={showLatest}>
          Current document
        </Button>
      </div>
    </div>
  );
}
