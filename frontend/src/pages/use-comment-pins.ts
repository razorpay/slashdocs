import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api";
import { COMMENT_STATUS } from "@/lib/constants";
import {
  canMovePin,
  initialsOf,
  parsePointAnchor,
  type PointAnchor,
} from "@/lib/comment-pins";
import { principalColor, principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { useDoc } from "./doc-context";
import { useFrameMessage } from "./use-frame-message";

// Typing in these, or in an open dialog or menu, keeps its keys.
const TYPING = 'input,textarea,select,[contenteditable="true"],[contenteditable=""]';
const OPEN_LAYER =
  '[role="dialog"][data-state="open"],[role="menu"][data-state="open"]';

// typingOrInLayer tells whether a key in the app belongs to a field, dialog
// or menu, or the document already took it.
export function typingOrInLayer(e: KeyboardEvent): boolean {
  const target = e.target instanceof Element ? e.target : null;
  return (
    e.defaultPrevented ||
    !!target?.closest(TYPING) ||
    !!document.querySelector(OPEN_LAYER)
  );
}

// useCommentPins draws the point comments of the document as pins in the
// render frame, and turns the frame's pin gestures into drafts and moves. The
// frame tells which pins it could not place, and which moved to their spot
// in the page.
// Open pins always show; a resolved one shows while its thread is open.
export function useCommentPins(
  frame: RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  ready: boolean,
  postToFrame: (message: Record<string, unknown>) => void,
) {
  const {
    docId,
    version,
    comments,
    drafts,
    activeComment,
    principal,
    editable,
    startDraft,
    moveDraft,
    setUnanchoredComments,
    setMovedPins,
    placingPin,
    setPlacingPin,
  } = useDoc();
  const q = useQueryClient();

  // Pins carry no comment text and no name beyond initials: the render frame
  // also runs the document's own scripts.
  const pins = useMemo(
    () => [
      ...comments.flatMap((c) =>
        c.anchor?.point &&
        (c.status !== COMMENT_STATUS.resolved || c.id === activeComment)
          ? [
              {
                id: c.id,
                anchor: c.anchor,
                initials: initialsOf(principalLabel(c.author)),
                replies: c.replies?.length ?? 0,
                movable: canMovePin(c, editable, principal),
                color: principalColor(c.author),
              },
            ]
          : [],
      ),
      ...drafts.flatMap((d) =>
        d.anchor?.point && d.version === version
          ? [
              {
                id: d.id,
                anchor: d.anchor,
                draft: true,
                movable: true,
                color: principal && principalColor(principal),
              },
            ]
          : [],
      ),
    ],
    [comments, drafts, version, activeComment, editable, principal],
  );
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:pins", pins, active: activeComment });
  }, [ready, pins, activeComment, postToFrame]);
  // The frame takes the focus, so that placing takes keys too.
  useEffect(() => {
    if (!ready) return;
    postToFrame({
      type: "slashdocs:pin-placing",
      on: !!placingPin,
      move: typeof placingPin === "string" ? placingPin : undefined,
    });
    if (placingPin && document.activeElement !== frame.current) frame.current?.focus();
  }, [ready, placingPin, postToFrame, frame]);

  // A pin dragged to a new spot: a draft moves here, a thread through the
  // API. A failed save puts the pin back with the next list.
  const movePin = useCallback(
    (id: string, anchor: PointAnchor) => {
      if (drafts.some((d) => d.id === id)) {
        moveDraft(id, anchor);
        return;
      }
      api
        .patchComment(docId, id, { anchor: { ...anchor, quote: anchor.quote ?? "" } })
        .catch(() => toast.error("Could not move the comment."))
        .finally(() => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }));
    },
    [drafts, moveDraft, docId, q],
  );
  // A pin let go over the app, outside the frame, goes back: the frame hears
  // no release there.
  const post = useRef(postToFrame);
  post.current = postToFrame;
  const onRelease = useRef(() => post.current({ type: "slashdocs:pins-release" }));

  useFrameMessage(frame, origin, ready, (data) => {
    if (data.type === "slashdocs:pins-result" && Array.isArray(data.results)) {
      // Capped: a forged message must not grow app state without bound.
      const results = (
        data.results as Array<{ id?: unknown; placed?: unknown; moved?: unknown }>
      ).slice(0, 10_000);
      // The ids of the results whose key has the value.
      const ids = (key: "placed" | "moved", value: boolean) =>
        new Set(
          results.flatMap((r) =>
            r?.[key] === value && typeof r.id === "string" ? [r.id] : [],
          ),
        );
      setUnanchoredComments("pins", ids("placed", false));
      setMovedPins(ids("moved", true));
    }
    if (data.type === "slashdocs:pin-placing")
      setPlacingPin(
        data.on === true && (typeof data.move === "string" ? data.move : true),
      );
    if (data.type === "slashdocs:pin-place") {
      const anchor = parsePointAnchor(data.anchor);
      if (anchor) startDraft({ quote: anchor.quote ?? "", anchor });
    }
    if (data.type === "slashdocs:pin-move" && typeof data.id === "string") {
      const anchor = parsePointAnchor(data.anchor);
      if (anchor) movePin(data.id, anchor);
    }
    if (data.type === "slashdocs:pin-dragging") {
      window.removeEventListener("pointerup", onRelease.current);
      if (data.on === true)
        window.addEventListener("pointerup", onRelease.current, { once: true });
    }
  });

  // C places a pin from outside the document too, unless the reader types
  // or is in a dialog. The Esc chord takes its own C first (useEscChord).
  // Esc stops placing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (placingPin) setPlacingPin(false);
        return;
      }
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || typingOrInLayer(e))
        return;
      e.preventDefault();
      setPlacingPin(!placingPin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placingPin, setPlacingPin]);
}
