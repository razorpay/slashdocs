import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import type { Comment } from "@/api";
import type { CommentDraft } from "@/lib/comment-drafts";
import { principalLabel } from "@/lib/principals";
import { CommentCard, CommentComposer } from "./doc-comments";

// A pin's rect in the render frame's viewport, as the bridge reports it.
export type PinRect = { left: number; top: number; width: number; height: number };

const GAP = 8;
const WIDTH = 320;
const EDGE = 12;

// place puts a popover beside a pin: to its right, or to its left near the
// document's right edge, with its top level with the pin, and inside the
// document area so it never covers the app's bar.
function place(frame: DOMRect, pin: PinRect, height: number) {
  const left = frame.left + pin.left;
  const right = left + pin.width;
  const x =
    right + GAP + WIDTH <= frame.right - EDGE
      ? right + GAP
      : Math.max(frame.left + EDGE, left - GAP - WIDTH);
  const top = frame.top + EDGE;
  const bottom = Math.min(frame.bottom, window.innerHeight) - EDGE;
  const y = Math.min(
    Math.max(top, frame.top + pin.top),
    Math.max(top, bottom - height),
  );
  return { x, y };
}

function Floating({
  frameRef,
  pin,
  label,
  onClose,
  showClose = true,
  passive = false,
  children,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pin: PinRect;
  label: string;
  onClose?: () => void;
  showClose?: boolean;
  // A preview lets the pointer through, so it never blocks the next pin.
  passive?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (frame) setAt(place(frame, pin, ref.current?.offsetHeight ?? 0));
  }, [frameRef, pin, children]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      // Esc closes the popover from inside it, as from the canvas.
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !onClose) return;
        e.stopPropagation();
        onClose();
      }}
      style={{
        left: at?.x ?? -9999,
        top: at?.y ?? -9999,
        width: WIDTH,
        // Focusable while it measures itself (a hidden field cannot take
        // the caret), then it grows in from the pin's side.
        opacity: at ? 1 : 0,
        scale: at ? "1" : "0.97",
        transformOrigin:
          at && at.x < (frameRef.current?.getBoundingClientRect().left ?? 0) + pin.left
            ? "right top"
            : "left top",
        pointerEvents: passive ? "none" : undefined,
        transition: "opacity 150ms ease-out, scale 150ms cubic-bezier(.23,1,.32,1)",
      }}
      className="fixed z-40"
    >
      <div className="max-h-[70vh] overflow-y-auto rounded-xl bg-[var(--color-surface)] shadow-xl ring-1 ring-[var(--color-border)]">
        {children}
      </div>
      {onClose && showClose && (
        // Floats on the corner so it never covers the card's own controls.
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className="absolute -right-2.5 -top-2.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-fg-muted)] shadow-md ring-1 ring-[var(--color-border)] transition-transform duration-150 ease-out hover:text-[var(--color-fg)] active:scale-95"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
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
      // The composer has its own cancel; Esc leaves it, and an empty one goes.
      <Floating
        frameRef={frameRef}
        pin={pin}
        label="New comment"
        onClose={onClose}
        showClose={false}
      >
        <CommentComposer draft={draft} />
      </Floating>
    );
  if (!comment) return null;
  return (
    <Floating frameRef={frameRef} pin={pin} label="Comment thread" onClose={onClose}>
      <CommentCard c={comment} docId={docId} autoReveal={false} popover />
    </Floating>
  );
}

// PinPreview is the short card shown while hovering a pin.
export function PinPreview({
  frameRef,
  pin,
  comment,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  pin: PinRect;
  comment: Comment;
}) {
  const replies = comment.replies?.length ?? 0;
  const body =
    comment.body.length > 140 ? `${comment.body.slice(0, 140)}…` : comment.body;
  return (
    <Floating frameRef={frameRef} pin={pin} label="Comment preview" passive>
      <div className="pointer-events-none space-y-1 p-3 text-sm">
        <div className="font-medium">{principalLabel(comment.author)}</div>
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--color-fg-muted)]">
          {body}
        </p>
        {replies > 0 && (
          <div className="text-xs text-[var(--color-fg-muted)]">
            {replies} {replies === 1 ? "reply" : "replies"}
          </div>
        )}
      </div>
    </Floating>
  );
}
