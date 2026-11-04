import { useEffect, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Undo2, X } from "lucide-react";
import {
  booksApi,
  chapterCrumb,
  partTitle,
  type BookState,
  type Manifest,
  type ManifestLink,
  type ReadingPosition,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { useDoc, type PositionTarget } from "./doc-context";

// The chapter reader's notes and end-of-chapter card. They float over the
// rendered chapter, inside the document context.

// Gives the reader the frame's restorePosition, which only the document
// context below it has.
function CaptureRestore({
  into,
}: {
  into: RefObject<((t: PositionTarget) => void) | null>;
}) {
  const { restorePosition } = useDoc();
  useEffect(() => {
    into.current = restorePosition ?? null;
    return () => {
      into.current = null;
    };
  }, [into, restorePosition]);
  return null;
}

function Note({
  label,
  children,
  onDismiss,
}: {
  label: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl bg-[var(--color-surface)] py-1 pl-4 pr-1 text-sm shadow-[var(--shadow-pop)] ring-1 ring-[var(--color-border)]"
    >
      {children}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// "Ch 3 · Retries": the other device's chapter and, once known, its section.
export function OfferNote({
  offer,
  manifest,
}: {
  offer: ReadingPosition;
  manifest: Manifest;
}) {
  const at = manifest.readingOrder.find(
    (l) => l.properties?.documentId === offer.document_id,
  );
  const headings = useQuery({
    queryKey: queryKeys.headings(offer.document_id, offer.version_id),
    queryFn: () => booksApi.headings(offer.document_id, offer.version_id),
    enabled: !!offer.section_id && !!offer.version_id,
    staleTime: Infinity,
    meta: { suppressGlobalError: true },
  });
  const section = headings.data?.items.find((h) => h.id === offer.section_id)?.text;
  const n = at?.properties?.number;
  const chapter = n ? `Ch ${n}` : (at?.title ?? "another chapter");
  return (
    <span className="min-w-0">
      On another device you were at {chapter}
      {section ? ` · ${section}` : ""}
    </span>
  );
}

export function ReaderOverlay({
  restoreRef,
  offer,
  onGoOffer,
  onDismissOffer,
  back,
  onBack,
  onDismissBack,
  end,
}: {
  restoreRef: RefObject<((t: PositionTarget) => void) | null>;
  offer: ReactNode;
  onGoOffer: () => void;
  onDismissOffer: () => void;
  back: boolean;
  onBack: () => void;
  onDismissBack: () => void;
  end: ReactNode;
}) {
  return (
    <>
      <CaptureRestore into={restoreRef} />
      {/* One live region, always mounted, so a note that appears is read out. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="Reading notes"
        className="pointer-events-none absolute inset-x-4 top-3 z-20 flex flex-col items-center gap-2"
      >
        {offer ? (
          <Note label="Other device" onDismiss={onDismissOffer}>
            {offer}
            <span aria-hidden="true" className="text-[var(--color-fg-muted)]">
              —
            </span>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onGoOffer}>
              Go there
            </Button>
          </Note>
        ) : null}
        {back ? (
          <Note label="Back" onDismiss={onDismissBack}>
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 h-7 px-2"
              onClick={onBack}
            >
              <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
              Back to where you were
            </Button>
          </Note>
        ) : null}
      </div>
      {end}
    </>
  );
}

export function EndOfChapter({
  bookId,
  docId,
  manifest,
  link,
  next,
  state,
}: {
  bookId: string;
  docId: string;
  manifest: Manifest;
  link: ManifestLink;
  next?: ManifestLink;
  state?: BookState;
}) {
  const qc = useQueryClient();
  const done = state?.chapters[docId]?.state === "done";
  const toggle = useMutation({
    mutationFn: (value: boolean) => booksApi.done(bookId, docId, value),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.book(bookId) }),
  });
  const pressed = toggle.isPending ? !!toggle.variables : done;
  const part = link.properties?.part;
  const nextPart = next?.properties?.part;
  const newPart =
    next?.properties?.kind === "chapter" && nextPart !== undefined && nextPart !== part
      ? partTitle(manifest, nextPart)
      : undefined;
  return (
    <section
      aria-label="End of chapter"
      className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg bg-[var(--color-surface)] p-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--color-border)]"
    >
      <Button
        variant={pressed ? "secondary" : "outline"}
        aria-pressed={pressed}
        onClick={() => toggle.mutate(!pressed)}
      >
        <Check
          aria-hidden="true"
          className={cn("h-4 w-4", pressed ? "opacity-100" : "opacity-40")}
        />
        Mark chapter done
      </Button>
      {next?.href ? (
        <Link
          to={next.href}
          className="group flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-[var(--color-surface-muted)]"
        >
          <span className="min-w-0">
            <span className="block text-xs text-[var(--color-fg-muted)]">
              {newPart ? `${newPart} starts` : "Next"}
            </span>
            <span className="block truncate font-medium text-[var(--color-fg)]">
              {chapterCrumb(next)}
            </span>
          </span>
          <ArrowRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      ) : (
        <Link
          to={`/app/b/${encodeURIComponent(bookId)}`}
          className="flex-1 rounded-md px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
        >
          You reached the end of the book. Back to the book home
        </Link>
      )}
    </section>
  );
}
