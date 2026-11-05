import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, History, RotateCcw } from "lucide-react";
import { api, docTitle, type Document, type Version } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapse, Skeleton } from "@/components/ui/misc";
import { LoadError } from "@/components/error-state";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { changeSummaryLines } from "@/lib/change-summary";
import { errorMessage } from "@/lib/errors";
import { formatTimestamp } from "@/lib/format-date";
import { historySessions, withoutUndone, type HistorySession } from "@/lib/history";
import { principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { useShowSaved } from "./use-show-saved";
import { useVersions } from "./use-versions";

// HistoryDialog lists the saved states of the document, in sessions of one
// person's edits, without the edits that their author undid. Opening an
// entry previews the document as it was then.
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
  // An undone run can end on the latest version. Then the newest entry left,
  // which has the same content, stands for it: it reads Current and opens the
  // latest version.
  const { sessions, newest } = useMemo(() => {
    const kept = withoutUndone(
      versions.data?.items ?? [],
      new Set(current === latest ? [] : [current]),
    );
    return { sessions: historySessions(kept), newest: kept.at(-1)?.id ?? latest };
  }, [versions.data, current, latest]);
  const shown = current === latest ? newest : current;
  const select = (versionID: string) => {
    const target = versionID === newest ? latest : versionID;
    if (target !== current) onSelectVersion(target);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hidden shrink-0 sm:inline-flex"
          aria-label="History"
          title="History"
        >
          <History className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      {/* The top stays put, so the dialog does not jump as a session opens. */}
      <DialogContent className="top-[12vh] max-w-2xl translate-y-0">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Every edit is kept. Open an entry to see the document as it was
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
            {sessions.map((session) => (
              <HistorySessionRow
                key={session.entries[0].id}
                session={session}
                current={shown}
                latest={newest}
                onSelect={select}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistorySessionRow({
  session,
  current,
  latest,
  onSelect,
}: {
  session: HistorySession;
  current: string;
  latest: string;
  onSelect: (versionID: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // The row shows the newest entry. The list under it shows the rest, each
  // with its own time below what it changed.
  const [newest, ...earlier] = session.entries;
  const oldest = session.entries[session.entries.length - 1];
  const viewing = current !== latest && session.entries.some((v) => v.id === current);
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] ${
        viewing ? "bg-[var(--color-accent-muted)]/35" : "bg-[var(--color-surface)]"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(newest.id)}
        className="flex w-full flex-col gap-1 rounded-xl p-4 text-left transition-colors hover:bg-[var(--color-surface-muted)]/60 focus-visible:-outline-offset-2"
        aria-current={newest.id === current ? "true" : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            <RelativeTime iso={newest.created_at} />
          </span>
          <EntryBadges version={newest} current={current} latest={latest} />
        </div>
        <span className="text-xs text-[var(--color-fg-muted)]">
          {principalLabel(session.author)}
          {earlier.length ? ` · since ${formatTimestamp(oldest.created_at)}` : ""}
        </span>
        <ChangeSummary version={newest} />
      </button>
      {earlier.length ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus-visible:-outline-offset-2"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
            />
            {expanded
              ? "Hide the earlier edits"
              : `Show ${earlier.length} earlier ${earlier.length === 1 ? "edit" : "edits"}`}
          </button>
          <Collapse open={expanded}>
            <ol className="space-y-1 px-2 pb-2">
              {earlier.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(v.id)}
                    aria-current={v.id === current ? "true" : undefined}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-surface-muted)]/60 focus-visible:-outline-offset-2"
                  >
                    <ChangeSummary version={v} />
                    <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                      <RelativeTime iso={v.created_at} />
                      <EntryBadges version={v} current={current} latest={latest} />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Collapse>
        </>
      ) : null}
    </div>
  );
}

function EntryBadges({
  version,
  current,
  latest,
}: {
  version: Version;
  current: string;
  latest: string;
}) {
  return (
    <>
      {version.id === current && current !== latest ? (
        <Badge variant="accent">
          <Check className="h-3 w-3" /> Viewing
        </Badge>
      ) : null}
      {version.id === latest ? <Badge variant="muted">Current</Badge> : null}
    </>
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
  const previewed = useRef(version?.id);
  previewed.current = version?.id;
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
    toast.promise(restoreTo(previous).then(showSaved), {
      loading: "Undoing the restore…",
      success: `Undid the restore of “${title}”.`,
      error: (e) => errorMessage(e, "Could not undo the restore."),
    });
  const restore = useMutation({
    mutationFn: ({ to }: { to: Version; previous?: Version; title: string }) =>
      restoreTo(to),
    onSuccess: (_, { previous, title }) =>
      toast.success(
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
          {
            onSuccess: (restored) =>
              previewed.current === version.id && showSaved(restored),
          },
        )
      }
    >
      <RotateCcw className="h-4 w-4" />
      Restore
    </Button>
  );
}
