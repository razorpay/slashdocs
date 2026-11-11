import { History } from "lucide-react";
import type { Version } from "@/api";
import { Button } from "@/components/ui/button";
import { RetryButton } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { loadFailed } from "@/lib/query-retry";
import { DocBanner } from "./doc-banner";
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
    <DocBanner
      icon={History}
      floating={floating}
      actions={
        <>
          {failed ? (
            <RetryButton query={versions} size="sm" variant="outline" />
          ) : canRestore ? (
            <RestoreButton docId={docId} version={version} />
          ) : null}
          <Button size="sm" variant="outline" onClick={showLatest}>
            Current document
          </Button>
        </>
      }
    >
      {version?.created_at ? (
        <>
          This is the document as it was <RelativeTime iso={version.created_at} />.
        </>
      ) : failed ? (
        "This is an earlier state of the document. The history did not load."
      ) : (
        "This is an earlier state of the document."
      )}
    </DocBanner>
  );
}
