import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { booksApi, type Manifest, type ManifestLink } from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { textLinkFragment } from "../../bridge/text-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchSnippet } from "@/components/browse/search-snippet";

const DEBOUNCE_MS = 250;

// The first highlighted match in a snippet, which the chapter scrolls to.
function firstMatch(snippet = ""): string {
  const start = snippet.indexOf("\u0002");
  if (start < 0) return "";
  const end = snippet.indexOf("\u0003", start);
  return snippet.slice(start + 1, end < 0 ? undefined : end).trim();
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return debounced;
}

// Full-text search of the book (R22). The server scopes it to the chapters
// this reader can open; results are matched to the manifest again so a row
// always has a chapter to open.
export function BookSearch({
  open,
  onOpenChange,
  bookId,
  manifest,
  currentDoc,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  manifest: Manifest;
  currentDoc: string;
  // href is the chapter link with the first match as a text fragment.
  onOpen: (href: string, docId: string) => void;
}) {
  const [text, setText] = useState("");
  const [thisChapter, setThisChapter] = useState(false);
  const q = useDebounced(text.trim());
  const doc = thisChapter ? currentDoc : undefined;
  const results = useQuery({
    queryKey: queryKeys.bookSearch(bookId, q, doc),
    queryFn: () => booksApi.search(bookId, q, doc),
    enabled: open && !!q,
    placeholderData: keepPreviousData,
    retry: false,
    meta: { suppressGlobalError: true },
  });
  const chapters = useMemo(() => {
    const byId = new Map<string, ManifestLink>();
    for (const l of manifest.readingOrder) {
      if (l.properties?.documentId && l.href) byId.set(l.properties.documentId, l);
    }
    return byId;
  }, [manifest]);
  const rows = (results.data?.items ?? []).flatMap((d) => {
    const link = chapters.get(d.id);
    return link ? [{ doc: d, link }] : [];
  });
  const open1 = (row: (typeof rows)[number]) => {
    const fragment = textLinkFragment({ quote: firstMatch(row.doc.snippet) }) ?? "";
    onOpen(`${row.link.href}${fragment}`, row.doc.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] max-w-xl translate-y-0 p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Search this book</DialogTitle>
          <DialogDescription>Results open at their first match.</DialogDescription>
        </DialogHeader>
        <form
          role="search"
          className="flex items-center gap-2 border-b border-[var(--color-border)] py-2 pl-4 pr-14"
          onSubmit={(e) => {
            e.preventDefault();
            if (rows[0]) open1(rows[0]);
          }}
        >
          <Search
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]"
          />
          <input
            type="search"
            aria-label="Search this book"
            placeholder={`Search ${manifest.metadata.title}`}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[var(--color-fg-muted)]"
          />
          <button
            type="button"
            aria-pressed={thisChapter}
            onClick={() => setThisChapter((v) => !v)}
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-xs font-medium ring-1 ring-[var(--color-border)] transition-colors",
              thisChapter
                ? "bg-[var(--color-accent-muted)] text-[var(--color-accent)] ring-transparent"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            This chapter
          </button>
        </form>
        <div
          aria-live="polite"
          aria-busy={results.isFetching}
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {!q ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
              Search every chapter you can open. Results open at the first match.
            </p>
          ) : results.isError ? (
            <div className="px-3 py-6 text-center text-sm">
              <p className="text-[var(--color-danger)]">
                {errorMessage(results.error, "Search failed.")}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => results.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : results.isLoading ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
              Searching…
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
              {thisChapter ? "No matches in this chapter" : "No matches in this book"}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((row) => (
                <li key={row.doc.id}>
                  <button
                    type="button"
                    onClick={() => open1(row)}
                    className="flex w-full gap-3 rounded-sm px-3 py-2 text-left hover:bg-[var(--color-surface-muted)] focus-visible:bg-[var(--color-surface-muted)] focus-visible:outline-none"
                  >
                    <span className="w-6 shrink-0 pt-px text-right text-sm tabular-nums text-[var(--color-fg-muted)]">
                      {row.link.properties?.number ?? ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                        {row.link.title}
                      </span>
                      {row.doc.snippet ? (
                        <SearchSnippet
                          as="span"
                          text={row.doc.snippet}
                          className="mt-0.5 line-clamp-2 block text-sm"
                        />
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
