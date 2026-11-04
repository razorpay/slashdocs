import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { booksApi, chapterByNumber } from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { Center, Skeleton } from "@/components/ui/misc";

// /app/b/:bookId/:number resolves through the manifest to the canonical
// chapter URL.
export function BookNumberRoute() {
  const { bookId = "", number = "" } = useParams();
  const q = useQuery({
    queryKey: queryKeys.book(bookId),
    queryFn: () => booksApi.manifest(bookId),
    retry: false,
    meta: { suppressGlobalError: true },
  });
  if (q.isLoading) return <Skeleton className="m-6 h-40" />;
  const link = q.data && chapterByNumber(q.data, Number(number));
  if (!link?.href) {
    return (
      <Center>
        <p className="text-sm text-[var(--color-fg-muted)]">
          That chapter is not available in this book.
        </p>
      </Center>
    );
  }
  return <Navigate to={link.href} replace />;
}

// The chapter reader. Task 13 replaces this with the reader that wraps the
// document workspace in the book rail; until then it opens the document.
export function BookReaderRoute() {
  const { docId = "" } = useParams();
  return <Navigate to={`/app/d/${encodeURIComponent(docId)}`} replace />;
}
