import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Comment } from "@/api";

// useCommentLink opens the thread that a ?comment= link names, by its root or
// one of its replies, once per link. A link to a thread that is not there
// says so, but only after fresh comments: cached ones can be older than the
// linked comment, as when a notification links to a new reply.
export function useCommentLink(
  docId: string,
  comments: UseQueryResult<{ items: Comment[] }>,
  open: (id: string) => void,
) {
  const [searchParams] = useSearchParams();
  const linked = searchParams.get("comment");
  const handled = useRef("");
  const { data, isFetching } = comments;
  useEffect(() => {
    if (!linked) {
      handled.current = "";
      return;
    }
    const key = `${docId}:${linked}`;
    if (!data?.items || handled.current === key) return;
    const root = data.items.find(
      (c) => c.id === linked || c.replies?.some((r) => r.id === linked),
    );
    if (!root && isFetching) return;
    handled.current = key;
    if (root) open(root.id);
    else toast("That comment was deleted or is no longer available.");
  }, [docId, linked, data, isFetching, open]);
}
