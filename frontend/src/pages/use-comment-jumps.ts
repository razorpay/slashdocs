import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { COMMENT_STATUS } from "@/lib/constants";
import { inDocumentOrder, nextThread } from "@/lib/comment-order";
import { useDoc } from "./doc-context";
import { plainKey } from "./use-comment-pins";

// The keys that go to the next or the previous open thread. Shift+J goes to
// the next unread one.
const STEPS: Record<string, 1 | -1> = { j: 1, n: 1, J: 1, k: -1, p: -1 };

// useCommentJumps goes from thread to thread with J and K, or N and P, in
// document order, in the app and in the document, which forwards the keys.
// In a document with no open threads, J and K scroll it as before. After
// each jump, from here, a link or the list, the document pulses the thread
// once it shows it.
export function useCommentJumps(
  ready: boolean,
  postToFrame: (message: Record<string, unknown>) => void,
) {
  const { comments, commentPositions, activeComment, jumpToComment, jump } = useDoc();
  const pulsed = useRef<{ id: string }>(undefined);
  useEffect(() => {
    if (!ready || !jump || pulsed.current === jump) return;
    pulsed.current = jump;
    postToFrame({ type: "slashdocs:pulse", id: jump.id });
  }, [ready, jump, postToFrame]);
  const order = useMemo(
    () =>
      inDocumentOrder(
        comments.filter((c) => c.status === COMMENT_STATUS.open),
        commentPositions,
      ),
    [comments, commentPositions],
  );
  const on = order.length > 0;
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:thread-keys", on });
  }, [ready, on, postToFrame]);
  // Before the bubbling listeners, as the one of J and K scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = STEPS[e.key];
      if (!step || !on || !plainKey(e, e.key)) return;
      e.preventDefault();
      if (e.repeat) return;
      const id = nextThread(
        order,
        activeComment,
        step,
        (c) => e.key !== "J" || !!c.unread,
      );
      if (id) jumpToComment(id);
      else toast("No unread threads", { id: "no-unread" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [on, order, activeComment, jumpToComment]);
}
