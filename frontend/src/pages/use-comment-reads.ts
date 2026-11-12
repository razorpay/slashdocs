import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, type Comment } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

// A thread becomes read once its popover shows it for this long.
export const READ_DELAY_MS = 1000;

const markedRead = (items: Comment[], id: string) =>
  items.map((c) => (c.id === id && c.unread ? { ...c, unread: false } : c));

// useCommentReads gives the comments with the reader's read state. The open
// thread that the reader read stays read: a live reply into it marks it read
// again at once, and never shows as unread meanwhile. Only a signed-in reader
// gets unread threads from the server, so only they mark threads read.
export function useCommentReads(
  docId: string,
  query: UseQueryResult<{ items: Comment[] }>,
  activeComment?: string,
) {
  const q = useQueryClient();
  // The thread whose popover showed it long enough, while it stays open.
  const [read, readThread] = useState<string>();
  const reading = read === activeComment ? read : undefined;
  const items = query.data?.items;
  const comments = useMemo(
    () => (reading ? markedRead(items ?? [], reading) : (items ?? [])),
    [items, reading],
  );
  useEffect(() => {
    if (!reading || !items?.some((c) => c.id === reading && c.unread)) return;
    q.setQueryData<{ items: Comment[] }>(
      queryKeys.comments(docId),
      (data) => data && { ...data, items: markedRead(data.items, reading) },
    );
    // A failed mark leaves the thread unread on the next load. A mark takes
    // the thread out of the inbox.
    api
      .markCommentRead(docId, reading)
      .then(() => q.invalidateQueries({ queryKey: queryKeys.inbox() }))
      .catch(() => {});
  }, [reading, items, docId, q]);
  return { comments, readThread };
}
