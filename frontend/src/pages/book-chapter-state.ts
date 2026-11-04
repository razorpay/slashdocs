import { useQuery } from "@tanstack/react-query";
import {
  booksApi,
  type BookState,
  type ChapterState,
  type ManifestLink,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";

// Chapter states as book home and the reader's rail show them. Every dot
// comes with its label as text, never colour alone (R13).
export type RowState = ChapterState | "planned";

export const STATE_LABEL: Record<RowState, string> = {
  not_started: "Not started",
  reading: "Reading",
  read: "Read",
  done: "Done",
  planned: "Planned",
};

export const STATE_DOT: Record<RowState, string> = {
  not_started: "border border-[var(--color-fg-muted)]",
  reading: "bg-[var(--color-accent)]",
  read: "bg-[var(--color-fg-muted)]",
  done: "bg-[var(--color-success,var(--color-fg-muted))]",
  planned: "border border-dashed border-[var(--color-fg-muted)]",
};

export function rowState(l: ManifestLink, s: BookState | undefined): RowState {
  if (l.properties?.kind === "planned") return "planned";
  const id = l.properties?.documentId;
  return (id && s?.chapters[id]?.state) || "not_started";
}

// The book's manifest and this reader's state. Both refetch when the window
// regains focus, so another device's reading shows up (A18).
export function useManifest(bookId: string) {
  return useQuery({
    queryKey: queryKeys.book(bookId),
    queryFn: () => booksApi.manifest(bookId),
    retry: false,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

export function useBookState(bookId: string) {
  return useQuery({
    queryKey: queryKeys.bookState(bookId),
    queryFn: () => booksApi.state(bookId),
    retry: false,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

// The changes since the reader last saw this chapter.
export function useChapterChanges(bookId: string, doc: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.bookChanges(bookId, doc),
    queryFn: () => booksApi.changes(bookId, doc),
    enabled,
    meta: { suppressGlobalError: true },
  });
}
