import { useEffect, useMemo, useRef } from "react";
import { COMMENT_STATUS } from "@/lib/constants";
import { inDocumentOrder, nextThread } from "@/lib/comment-order";
import { useDoc } from "./doc-context";
import { plainKey } from "./use-comment-pins";

// The keys that go to the next and the previous open thread, as in Vim. J
// and K always scroll the document.
const STEPS: Record<string, 1 | -1> = { n: 1, N: -1 };

// useCommentJumps goes from thread to thread with N and Shift+N, in document
// order, in the app and in the document, which forwards the keys. After each
// jump, from here, a link or the list, the document pulses the thread once
// it shows it.
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = STEPS[e.key];
      if (!step || !on || !plainKey(e, e.key)) return;
      e.preventDefault();
      if (e.repeat) return;
      const id = nextThread(order, activeComment, step);
      if (id) jumpToComment(id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [on, order, activeComment, jumpToComment]);
}
