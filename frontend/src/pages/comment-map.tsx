import { useMemo } from "react";
import type { Comment } from "@/api";
import { cn } from "@/lib/cn";
import { anchorLabel } from "@/lib/comment-pins";
import { commentTicks } from "@/lib/comment-ticks";
import { useClientHeight } from "@/lib/use-client-height";
import { useCoarsePointer } from "@/lib/use-media-query";
import { useDoc } from "./doc-context";

const SNIPPET_LENGTH = 80;
// Ticks closer than the height of one tick's target would stack, so they
// share it. A finger needs a 40px target.
const TICK_PX = 16;
const TOUCH_TICK_PX = 40;

const snippet = (c: Comment) => {
  const label = anchorLabel(c);
  return label.length > SNIPPET_LENGTH ? `${label.slice(0, SNIPPET_LENGTH)}…` : label;
};

// A faint strip down the document's scrollbar with one tick per thread at its
// place in the whole document. It lets a reader see where threads are without
// scrolling, and open one. Threads at one place share a tick with their
// count, which opens each of them in turn.
export function CommentMap({ comments }: { comments: Comment[] }) {
  const {
    commentPositions,
    documentHeight,
    activeComment,
    setActiveComment,
    scrollDocumentTo,
  } = useDoc();
  const [stripRef, viewportHeight] = useClientHeight<HTMLDivElement>();
  const tickPx = useCoarsePointer() ? TOUCH_TICK_PX : TICK_PX;

  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const ticks = commentTicks({
    ids: comments.map((c) => c.id),
    positions: commentPositions,
    scrollHeight: documentHeight,
    viewportHeight,
  });

  const groups = ticks?.reduce<{ ids: string[]; y: number; first: number }[]>(
    (out, { id, y }, index) => {
      const last = out.at(-1);
      if (last && (y - last.y) * viewportHeight < tickPx) last.ids.push(id);
      else out.push({ ids: [id], y, first: index + 1 });
      return out;
    },
    [],
  );

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
      {groups?.map(({ ids, y, first }) => {
        const active = !!activeComment && ids.includes(activeComment);
        const many = ids.length > 1;
        const quotes = ids.map((id) => snippet(byId.get(id)!)).filter(Boolean);
        const total = ticks!.length;
        const label = many
          ? `Comments ${first} to ${first + ids.length - 1} of ${total}`
          : `Comment ${first} of ${total}${quotes[0] ? `: ${quotes[0]}` : ""}`;
        return (
          <button
            key={ids[0]}
            type="button"
            // The comments list reaches every thread from the keyboard, so
            // ticks only add a pointer shortcut.
            tabIndex={-1}
            aria-current={active || undefined}
            aria-label={label}
            title={quotes.join("\n")}
            onClick={() =>
              jump(ids[(ids.indexOf(activeComment ?? "") + 1) % ids.length])
            }
            // On a touch screen, the pseudo-element makes a 40px target that
            // reaches over the edge of the document.
            className="pointer-events-auto group absolute inset-x-0 h-4 -translate-y-1/2 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:right-0 pointer-coarse:after:-left-7"
            style={{ top: `${y * 100}%` }}
          >
            <span
              className={cn(
                "absolute inset-x-0.5 top-1/2 -translate-y-1/2 transition-colors",
                many
                  ? "grid h-3.5 place-items-center rounded-sm bg-[var(--color-fg-muted)] text-[9px] leading-none font-semibold text-[var(--color-bg)] tabular-nums"
                  : "h-0.5 rounded-full bg-[var(--color-fg-muted)]/50",
                active
                  ? "bg-[var(--color-accent)]"
                  : "group-hover:bg-[var(--color-fg)]",
              )}
            >
              {many && ids.length}
            </span>
          </button>
        );
      })}
    </div>
  );
}
