import { useMemo } from "react";
import type { Comment } from "@/api";
import { cn } from "@/lib/cn";
import { commentTicks } from "@/lib/comment-rail";
import { useClientHeight } from "@/lib/use-client-height";
import { useDoc } from "./doc-context";

const SNIPPET_LENGTH = 80;

const snippet = (c: Comment) => {
  const quote = (c.selected_text || c.anchor?.quote || "").trim();
  return quote.length > SNIPPET_LENGTH ? `${quote.slice(0, SNIPPET_LENGTH)}…` : quote;
};

// A faint strip down the comments rail with one tick per thread at its place in
// the whole document. It lets a reader see where threads are without scrolling,
// and jump to one.
export function CommentMap({
  comments,
  topInset,
}: {
  comments: Comment[];
  topInset: number;
}) {
  const {
    commentPositions,
    commentViewport,
    activeComment,
    setActiveComment,
    scrollDocumentTo,
  } = useDoc();
  const [stripRef, viewportHeight] = useClientHeight<HTMLDivElement>();

  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const ticks = commentTicks({
    ids: comments.map((c) => c.id),
    positions: commentPositions,
    scrollHeight: commentViewport.scrollHeight,
    viewportHeight,
    topInset,
  });

  const jump = (id: string) => {
    if (id !== activeComment) {
      setActiveComment(id);
      return;
    }
    // The bridge reveals a thread only when it becomes active, so an
    // already-active one needs an explicit scroll.
    const top = commentPositions.get(id)?.top ?? 0;
    scrollDocumentTo(Math.max(0, top - viewportHeight / 3));
  };

  return (
    <div ref={stripRef} className="pointer-events-none absolute inset-y-0 right-0 w-3">
      {ticks?.map((tick, index) => {
        const active = tick.id === activeComment;
        const quote = snippet(byId.get(tick.id)!);
        return (
          <button
            key={tick.id}
            type="button"
            // The cards are already keyboard-reachable, so ticks only add a pointer shortcut.
            tabIndex={-1}
            aria-current={active || undefined}
            aria-label={`Comment ${index + 1} of ${ticks.length}${quote && `: ${quote}`}`}
            title={quote}
            onClick={() => jump(tick.id)}
            className="pointer-events-auto group absolute inset-x-0 h-4 -translate-y-1/2 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            style={{ top: `${tick.y * 100}%` }}
          >
            <span
              className={cn(
                "absolute inset-x-0.5 top-1/2 h-0.5 -translate-y-1/2 rounded-full transition-colors",
                active
                  ? "bg-[var(--color-accent)]"
                  : "bg-[var(--color-fg-muted)]/50 group-hover:bg-[var(--color-fg)]",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
