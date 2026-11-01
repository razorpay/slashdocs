import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, History, RotateCcw } from "lucide-react";
import { api, type Version } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { historySessions, type HistorySession } from "@/lib/history";
import { principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";

// HistoryDialog lists every saved state of the document, in sessions of one
// person's edits. Opening an entry previews the document as it was then.
export function HistoryDialog({
  current,
  latest,
  versions,
  onSelectVersion,
}: {
  current: string;
  latest: string;
  versions: Version[];
  onSelectVersion: (versionID: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sessions = useMemo(() => historySessions(versions), [versions]);
  const select = (versionID: string) => {
    if (versionID !== current) onSelectVersion(versionID);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Every edit is kept. Open an entry to see the document as it was, and restore
            it to bring it back.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
          {sessions.map((session) => (
            <HistorySessionRow
              key={session.entries[0].id}
              session={session}
              current={current}
              latest={latest}
              onSelect={select}
            />
          ))}
        </div>
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
  const [newest] = session.entries;
  const oldest = session.entries[session.entries.length - 1];
  const viewing = session.entries.some((v) => v.id === current);
  const edits = session.entries.length;
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] ${
        viewing ? "bg-[var(--color-accent-muted)]/35" : "bg-[var(--color-surface)]"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(newest.id)}
        className="flex w-full flex-col gap-1 rounded-xl p-4 text-left transition-colors hover:bg-[var(--color-surface-muted)]/60"
        aria-current={newest.id === current ? "true" : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{formatTimestamp(newest.created_at)}</span>
          <EntryBadges version={newest} current={current} latest={latest} />
        </div>
        <span className="text-xs text-[var(--color-fg-muted)]">
          {principalLabel(session.author)}
          {edits > 1
            ? ` · ${edits} edits since ${formatTimestamp(oldest.created_at)}`
            : ""}
        </span>
        <ChangeSummary version={newest} />
      </button>
      {edits > 1 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            {expanded ? "Hide the edits" : `Show all ${edits} edits`}
          </button>
          {expanded ? (
            <ol className="space-y-1 px-2 pb-2">
              {session.entries.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(v.id)}
                    aria-current={v.id === current ? "true" : undefined}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-surface-muted)]/60"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      {formatTimestamp(v.created_at)}
                      <EntryBadges version={v} current={current} latest={latest} />
                    </span>
                    <ChangeSummary version={v} />
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
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
      {version.id === current ? (
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
// keeps everything, so a restore can itself be undone by restoring again.
export function RestoreButton({
  docId,
  version,
  onRestored,
}: {
  docId: string;
  version?: Version;
  onRestored: () => void;
}) {
  const q = useQueryClient();
  const restore = useMutation({
    mutationFn: (v: Version) =>
      api.restoreVersion(
        docId,
        v.id,
        `Restored the version from ${formatTimestamp(v.created_at)}`,
      ),
    onSuccess: () => {
      for (const queryKey of [
        queryKeys.document(docId),
        queryKeys.versions(docId),
        queryKeys.approvalsAll(docId),
        queryKeys.documents(),
      ]) {
        q.invalidateQueries({ queryKey });
      }
      onRestored();
      toast.success("Restored.");
    },
    onError: (e) => toast.error(errorMessage(e, "Could not restore this version.")),
  });
  if (!version) return null;
  return (
    <Button
      size="sm"
      className="shrink-0"
      disabled={restore.isPending}
      onClick={() => restore.mutate(version)}
    >
      <RotateCcw className="h-4 w-4" />
      {restore.isPending ? "Restoring…" : "Restore"}
    </Button>
  );
}
