import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Comment } from "@/api";
import type { CommentDraft } from "@/lib/comment-drafts";
import { principalLabel } from "@/lib/principals";
import { RelativeTime } from "@/components/ui/relative-time";
import { CommentComposer } from "./doc-comments";
import { PersonAvatar } from "./doc-comment-parts";
import { ThreadPopover } from "./doc-comment-thread";

// A pin's rect in the render frame's viewport, as the bridge reports it.
export type PinRect = { left: number; top: number; width: number; height: number };

const GAP = 8;
const THREAD_WIDTH = 320;
const COMPOSER_WIDTH = 320;
const EDGE = 12;

type Placement = "beside" | "over";

// place puts a popover beside a pin: to its right, or to its left near the
// document's right edge, with its top level with the pin, and inside the
// document area so it never covers the app's bar. "over" grows out of the pin
// itself instead: the box's bottom left corner sits on the pin's tip.
function place(
  frame: DOMRect,
  pin: PinRect,
  size: { width: number; height: number },
  placement: Placement,
) {
  const left = frame.left + pin.left;
  const right = left + pin.width;
  const top = frame.top + EDGE;
  const bottom = Math.min(frame.bottom, window.innerHeight) - EDGE;
  if (placement === "over")
    return {
      x: Math.min(left, frame.right - EDGE - size.width),
      y: Math.max(top, frame.top + pin.top + pin.height - size.height),
    };
  const x =
    right + GAP + size.width <= frame.right - EDGE
      ? right + GAP
      : Math.max(frame.left + EDGE, left - GAP - size.width);
  const y = Math.min(
    Math.max(top, frame.top + pin.top),
    Math.max(top, bottom - size.height),
  );
  return { x, y };
}

function Floating({
  frameRef,
  pin,
  label,
  onClose,
  width,
  placement = "beside",
  passive = false,
  instant = false,
  className,
  children,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pin: PinRect;
  label: string;
  onClose?: () => void;
  width?: number;
  placement?: Placement;
  // A preview lets the pointer through, so it never blocks the next pin.
  passive?: boolean;
  // instant skips the grow-in, for a preview that follows another one.
  instant?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    const el = ref.current;
    if (frame && el)
      setAt(
        place(
          frame,
          pin,
          { width: el.offsetWidth, height: el.offsetHeight },
          placement,
        ),
      );
  }, [frameRef, pin, children, placement]);
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !onClose) return;
    e.stopPropagation();
    onClose();
  };
  const frameLeft = frameRef.current?.getBoundingClientRect().left ?? 0;
  // It grows from the pin: from the pin's tip when over it, else from the
  // side that faces the pin.
  const origin =
    placement === "over"
      ? "left bottom"
      : at && at.x < frameLeft + pin.left
        ? "right top"
        : "left top";
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      // Esc closes the popover from inside it, as from the canvas.
      onKeyDown={closeOnEscape}
      style={{
        left: at?.x ?? -9999,
        top: at?.y ?? -9999,
        width,
        // Focusable while it measures itself (a hidden field cannot take
        // the caret), then it grows in.
        opacity: at ? 1 : 0,
        scale: at ? "1" : placement === "over" ? "0.92" : "0.97",
        transformOrigin: origin,
        pointerEvents: passive ? "none" : undefined,
        transition: instant
          ? "none"
          : "opacity 150ms ease-out, scale 150ms cubic-bezier(.23,1,.32,1)",
      }}
      className={`fixed z-40 ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

// PinPopover shows the active pin's thread, or the new comment for a pin
// being placed, beside the pin on the canvas, as in Figma.
export function PinPopover({
  frameRef,
  pin,
  comment,
  draft,
  docId,
  onClose,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pin: PinRect;
  comment?: Comment;
  draft?: CommentDraft;
  docId: string;
  onClose: () => void;
}) {
  if (draft)
    return (
      // Esc leaves it, and an empty one goes.
      <Floating
        frameRef={frameRef}
        pin={pin}
        label="New comment"
        onClose={onClose}
        width={COMPOSER_WIDTH}
      >
        <CommentComposer draft={draft} compact />
      </Floating>
    );
  if (!comment) return null;
  return (
    <Floating
      frameRef={frameRef}
      pin={pin}
      label="Comment thread"
      onClose={onClose}
      width={THREAD_WIDTH}
      className="overflow-hidden rounded-xl bg-[var(--color-surface)] shadow-xl ring-1 ring-[var(--color-border)]"
    >
      <ThreadPopover c={comment} docId={docId} onClose={onClose} />
    </Floating>
  );
}

// PinPreview is shown while hovering a pin: it grows out of the pin itself,
// as in Figma, with who wrote it, when, and the start of the text.
export function PinPreview({
  frameRef,
  pin,
  comment,
  instant = false,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pin: PinRect;
  comment: Comment;
  instant?: boolean;
}) {
  const replies = comment.replies?.length ?? 0;
  return (
    <Floating
      frameRef={frameRef}
      pin={pin}
      label="Comment preview"
      placement="over"
      passive
      instant={instant}
      className="max-w-[300px] rounded-md bg-[var(--color-surface)] shadow-lg ring-1 ring-[var(--color-border)]"
    >
      <div className="pointer-events-none flex items-start gap-2 p-2.5 pr-3">
        <PersonAvatar who={comment.author} />
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-semibold">
              {principalLabel(comment.author)}
            </span>
            {comment.created_at ? (
              <span className="shrink-0 text-[11px] text-[var(--color-fg-muted)]">
                <RelativeTime iso={comment.created_at} />
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 break-words text-sm leading-relaxed">
            {comment.body}
          </p>
          {replies > 0 ? (
            <div className="text-xs text-[var(--color-fg-muted)]">
              {replies} {replies === 1 ? "reply" : "replies"}
            </div>
          ) : null}
        </div>
      </div>
    </Floating>
  );
}
