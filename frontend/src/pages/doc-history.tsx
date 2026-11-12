import { useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, RotateCcw } from "lucide-react";
import { api, docTitle, type Document, type Version } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { LoadError } from "@/components/error-state";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { changeSummaryLines } from "@/lib/change-summary";
import { errorMessage } from "@/lib/errors";
import { principalLabel, principalNames } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { useShowSaved } from "./use-show-saved";
import { useVersions } from "./use-versions";

// HistoryDialog lists the versions of the document, the newest first. A
// version is one sitting of editing, a push, an upload or a restore, and
// each one is a row: its time, the people who made it, and what it changed.
// Opening an entry previews the document as it was then.
export function HistoryDialog({
  open,
  onOpenChange,
  docId,
  current,
  latest,
  canRestore,
  onSelectVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  current: string;
  latest: string;
  canRestore: boolean;
  onSelectVersion: (versionID: string) => void;
}) {
  const versions = useVersions(docId);
  // The people and the line of the newest version change while people
  // type, with no event for each one, so the History reads the versions
  // again when it opens.
  const q = useQueryClient();
  useEffect(() => {
    if (open) void q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
  }, [open, q, docId]);
  const entries = useMemo(
    () => [...(versions.data?.items ?? [])].sort((a, b) => b.number - a.number),
    [versions.data],
  );
  const select = (versionID: string) => {
    if (versionID !== current) onSelectVersion(versionID);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-2xl translate-y-0">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Open an entry to see the document as it was
            {canRestore ? ", and restore it to bring it back." : "."}
          </DialogDescription>
        </DialogHeader>
        {versions.isPending ? (
          <div className="space-y-2" aria-label="Loading the history">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        ) : versions.error ? (
          <LoadError
            title="Could not load the history"
            error={versions.error}
            query={versions}
          />
        ) : (
          <div className="enter max-h-[60vh] space-y-2 overflow-auto pr-1">
            {entries.map((version) => (
              <HistoryRow
                key={version.id}
                version={version}
                current={current}
                latest={latest}
                onSelect={select}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryRow({
  version,
  current,
  latest,
  onSelect,
}: {
  version: Version;
  current: string;
  latest: string;
  onSelect: (versionID: string) => void;
}) {
  const viewing = version.id === current && current !== latest;
  // The people who typed in the version, or else the person who made it.
  const people = version.authors?.length
    ? version.authors
    : version.created_by
      ? [version.created_by]
      : [];
  return (
    <button
      type="button"
      onClick={() => onSelect(version.id)}
      aria-current={version.id === current ? "true" : undefined}
      className={`flex w-full flex-col gap-1 rounded-xl border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-surface-muted)]/60 focus-visible:-outline-offset-2 ${
        viewing ? "bg-[var(--color-accent-muted)]/35" : "bg-[var(--color-surface)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          <RelativeTime iso={version.edited_at ?? version.created_at} />
        </span>
        {viewing ? (
          <Badge variant="accent">
            <Check className="h-3 w-3" /> Viewing
          </Badge>
        ) : null}
        {version.id === latest ? <Badge variant="muted">Current</Badge> : null}
      </div>
      <span className="text-xs text-[var(--color-fg-muted)]">
        {people.length ? principalNames(people) : principalLabel()}
      </span>
      <ChangeSummary version={version} />
    </button>
  );
}

function ChangeSummary({ version }: { version: Version }) {
  const lines = changeSummaryLines(version.change_summary);
  const className = "text-sm text-[var(--color-fg-muted)]";
  if (lines.length > 1) {
    return (
      <ul className={`${className} list-disc space-y-0.5 pl-5`}>
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className={className}>
      {lines[0] || (version.number === 1 ? "Created" : "Edited")}
    </p>
  );
}

// RestoreButton brings back the version on screen as the newest one. History
// keeps everything, so Undo restores the entry that was the newest before.
// The saved data always refreshes, and the toasts name the document. Only a
// reader who still previews the entry goes to the restored document: a
// Restore that ends after they moved on leaves them where they went.
export function RestoreButton({
  docId,
  version,
}: {
  docId: string;
  version?: Version;
}) {
  const q = useQueryClient();
  const showSaved = useShowSaved();
  const newest = useVersions(docId).data?.items.at(-1);
  const restoreTo = async (v: Version) => {
    const restored = await api.restoreVersion(docId, v.id);
    for (const queryKey of [
      queryKeys.document(docId),
      queryKeys.versions(docId),
      queryKeys.approvalsAll(docId),
      queryKeys.documents(),
    ]) {
      q.invalidateQueries({ queryKey });
    }
    return restored;
  };
  const undo = (previous: Version, title: string) =>
    toast.promise(restoreTo(previous).then(showSaved()), {
      loading: "Undoing the restore…",
      success: `Undid the restore of “${title}”.`,
      error: (e) => errorMessage(e, "Could not undo the restore."),
    });
  const restore = useMutation({
    mutationFn: ({ to }: { to: Version; previous?: Version; title: string }) =>
      restoreTo(to),
    onSuccess: (restored, { previous, title }) =>
      restored.unchanged
        ? // The entry is the document as it is: nothing was restored.
          toast.info(`“${title}” already has this content.`)
        : toast.success(
            `Restored an earlier version of “${title}”.`,
            previous && {
              action: { label: "Undo", onClick: () => undo(previous, title) },
            },
          ),
    onError: (e) => toast.error(errorMessage(e, "Could not restore this entry.")),
  });
  if (!version) return null;
  return (
    <Button
      size="sm"
      className="shrink-0"
      busy={restore.isPending}
      onClick={() =>
        restore.mutate(
          {
            to: version,
            previous: newest,
            title: docTitle(q.getQueryData<Document>(queryKeys.document(docId)) ?? {}),
          },
          { onSuccess: showSaved() },
        )
      }
    >
      <RotateCcw className="h-4 w-4" />
      Restore
    </Button>
  );
}
