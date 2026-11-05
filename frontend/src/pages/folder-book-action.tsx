import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { toast } from "sonner";
import { api, APIError } from "@/api";
import { errorMessage } from "@/lib/errors";
import { booksApi } from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";

// The folder header's book action: "Read as book" when the folder has a book,
// "Make this a book" for folder editors when it does not. Nothing at all when
// the server has books turned off, or when the lookup failed.
export function FolderBookAction({
  folderId,
  canEdit,
}: {
  folderId: string;
  canEdit: boolean;
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: queryKeys.config(),
    queryFn: api.getConfig,
    staleTime: 60_000,
  });
  const enabled = config.data?.books_enabled === true;
  const book = useQuery({
    queryKey: queryKeys.folderBook(folderId),
    queryFn: () => booksApi.folderBook(folderId),
    enabled,
    retry: false,
    // 404 is the usual answer: most folders are not books.
    meta: { suppressGlobalError: true },
  });
  const create = useMutation({
    mutationFn: () => booksApi.createBook(folderId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: queryKeys.folderBook(folderId) });
      nav(`/app/b/${encodeURIComponent(r.book_id)}/outline`, {
        state: { placed: r.placed.length, notInOutline: r.not_in_outline.length },
      });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not make this a book.")),
  });

  if (!enabled || book.isLoading) return null;
  if (book.data) {
    return (
      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link
          aria-label="Read as book"
          to={`/app/b/${encodeURIComponent(book.data.book_id)}`}
        >
          <BookOpen aria-hidden="true" className="h-3.5 w-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">Read as book</span>
        </Link>
      </Button>
    );
  }
  // Only a 404 means "no book"; after any other error the folder may well
  // have one.
  const noBook = book.error instanceof APIError && book.error.status === 404;
  if (!canEdit || !noBook) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={create.isPending}
      onClick={() => create.mutate()}
    >
      <BookOpen aria-hidden="true" className="h-3.5 w-3.5 sm:mr-1.5" />
      Make this a book
    </Button>
  );
}
