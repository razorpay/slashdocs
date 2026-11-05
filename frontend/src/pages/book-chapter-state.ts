import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  booksApi,
  readingWriteFailure,
  type BookState,
  type ChapterState,
  type ManifestLink,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";

// Chapter states as book home and the reader's rail show them. Every dot
// has its own shape (book-state-dot.tsx) and comes with its label as text,
// never colour alone (R13).
export type RowState = ChapterState | "planned";

export const STATE_LABEL: Record<RowState, string> = {
  not_started: "Not started",
  reading: "Reading",
  read: "Read",
  done: "Done",
  planned: "Planned",
};

export function rowState(l: ManifestLink, s: BookState | undefined): RowState {
  if (l.properties?.kind === "planned") return "planned";
  const id = l.properties?.documentId;
  return (id && s?.chapters[id]?.state) || "not_started";
}

// An outage (5xx, including 503 group_membership_unavailable) or a network
// error is tried twice more, 0.5 s and 1 s apart. A refusal or 429
// rate_limited is not: a retry would only fail the same way.
const MAX_RETRIES = 2;
const retry = (count: number, err: unknown) =>
  count < MAX_RETRIES && readingWriteFailure(err) === "retry";
const retryDelay = (attempt: number) => 500 * 2 ** attempt;

// The chapter has a version the reader has not seen.
export function isUpdated(l: ManifestLink, s: BookState | undefined): boolean {
  const id = l.properties?.documentId;
  return !!id && !!s?.chapters[id]?.updated;
}

// The book's manifest and this reader's state. Both refetch when the window
// regains focus, so another device's reading shows up (A18).
export function useManifest(bookId: string) {
  return useQuery({
    queryKey: queryKeys.book(bookId),
    queryFn: () => booksApi.manifest(bookId),
    retry,
    retryDelay,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

export function useBookState(bookId: string) {
  return useQuery({
    queryKey: queryKeys.bookState(bookId),
    queryFn: () => booksApi.state(bookId),
    retry,
    retryDelay,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

// After a reading write (open, seen, done, reached end): the reader's state
// and changes moved, the manifest did not. Refetching it would only bring
// version churn.
export function invalidateReading(qc: QueryClient, bookId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.bookState(bookId) }),
    qc.invalidateQueries({ queryKey: [...queryKeys.book(bookId), "changes"] }),
  ]);
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
