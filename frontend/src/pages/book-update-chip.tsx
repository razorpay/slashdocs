import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { booksApi } from "@/lib/books";
import { changeSummaryLines } from "@/lib/change-summary";
import { Popover } from "@/components/ui/popover";
import {
  invalidateReading,
  useBookState,
  useChapterChanges,
} from "./book-chapter-state";

function ChangesPanel({
  bookId,
  doc,
  onOpenSection,
}: {
  bookId: string;
  doc: string;
  onOpenSection: (section: string) => void;
}) {
  const q = useChapterChanges(bookId, doc, true);
  if (q.isLoading) {
    return <p className="text-[var(--color-fg-muted)]">Loading the changes…</p>;
  }
  if (q.isError || !q.data) {
    return (
      <p className="text-[var(--color-fg-muted)]">
        Could not load the changes.{" "}
        <button
          type="button"
          className="text-[var(--color-accent)] underline-offset-4 hover:underline"
          onClick={() => q.refetch()}
        >
          Retry
        </button>
      </p>
    );
  }
  const versions = [...q.data.versions].sort((a, b) => b.number - a.number);
  const sections = q.data.changed_sections;
  const newest = versions[0]?.number;
  const count = `${sections.length} ${sections.length === 1 ? "section" : "sections"} changed`;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-[var(--color-fg)]">
        {newest ? `Version ${newest} · ${count}` : count}
      </h3>
      {versions.length ? (
        <ul className="space-y-3">
          {versions.map((v) => {
            const lines = changeSummaryLines(v.change_summary);
            return (
              <li key={v.id}>
                <p className="text-xs font-medium text-[var(--color-fg-muted)]">
                  Version {v.number}
                </p>
                {lines.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--color-fg)]">
                    {lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[var(--color-fg-muted)]">
                    No note was written for this version.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {sections.length ? (
        <div>
          <p className="text-xs font-medium text-[var(--color-fg-muted)]">
            Changed sections
          </p>
          <ul className="mt-1 space-y-0.5">
            {sections.map((s) => (
              <li key={s.id}>
                {s.removed ? (
                  <span className="text-[var(--color-fg-muted)]">
                    <s>{s.title || s.id}</s> (removed)
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenSection(s.id)}
                    className="flex w-full items-center gap-2 rounded-sm py-0.5 text-left text-[var(--color-accent)] hover:underline"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning)]"
                    />
                    {s.title || s.id}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// A small chip beside the chapter title while the chapter has versions the
// reader has not seen (R18, R19). Opening a changed section or dismissing the
// chip marks the version being read as seen.
export function BookUpdateChip({
  bookId,
  doc,
  versionId,
  onOpenSection,
  onDismissed,
}: {
  bookId: string;
  doc: string;
  // The version being read. Seeing it never marks a newer one seen (A7).
  versionId: string;
  onOpenSection: (section: string) => void;
  // Called as the chip hides with focus inside it, so the page can move
  // focus somewhere stable instead of letting it drop to the body.
  onDismissed?: () => void;
}) {
  const qc = useQueryClient();
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // Hidden at once, before the state is fetched again.
  const [seenVersion, setSeenVersion] = useState<string>();
  const state = useBookState(bookId);
  // Whether focus was in the chip when the reader acted. Read when the
  // request returns, by which time a browser may have moved focus.
  const hadFocus = useRef(false);
  const seen = useMutation({
    mutationFn: () => booksApi.seen(bookId, doc, versionId),
    onSuccess: () => {
      if (hadFocus.current) onDismissed?.();
      setSeenVersion(versionId);
    },
    onSettled: () => {
      hadFocus.current = false;
      return invalidateReading(qc, bookId);
    },
  });
  const markSeen = () => {
    if (seen.isPending) return;
    hadFocus.current = !!root.current?.contains(document.activeElement);
    seen.mutate();
  };
  if (!state.data?.chapters[doc]?.updated || seenVersion === versionId) return null;
  return (
    <span
      ref={root}
      className="inline-flex shrink-0 items-center rounded-full bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-xs text-[var(--color-fg)]"
    >
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Changes since you read"
        trigger={
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-full pl-2.5 pr-1 font-medium hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)]"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]"
            />
            <span className="sm:hidden">Updated</span>
            <span className="hidden sm:inline">Updated since you read</span>
          </button>
        }
      >
        <ChangesPanel
          bookId={bookId}
          doc={doc}
          onOpenSection={(section) => {
            setOpen(false);
            onOpenSection(section);
            seen.mutate();
          }}
        />
      </Popover>
      <button
        type="button"
        aria-label="Dismiss update"
        title="Mark as seen"
        // Not disabled: a disabled button loses focus to the body.
        aria-disabled={seen.isPending || undefined}
        onClick={markSeen}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-fg-muted)] hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] hover:text-[var(--color-fg)]"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}
