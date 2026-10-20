import {
  parseTextLink,
  textLinkAnchor,
  textLinkFragment,
  TEXT_LINK_PREFIX,
} from "../../bridge/text-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Anchor } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { matchesCommentFilter } from "@/lib/constants";
import { Center } from "@/components/ui/misc";
import { CHORD_KEYS, CHORD_WINDOW_MS } from "@/lib/esc-chord";
import { cursorsShownStore, parseCursorSpot } from "@/lib/live-cursors";
import { principalLabel } from "@/lib/principals";
import { useDocumentExport } from "./use-document-export";
import { useDoc } from "./doc-context";
import { useBridgeHost } from "./use-bridge-host";
import { PinPopover, PinPreview, type PinRect } from "./doc-canvas-popover";

const FORWARDED_KEYS = new Set<string>([
  "Escape",
  "?",
  ...CHORD_KEYS.map((item) => item.key),
]);
const VIM_KEYS = new Set(["j", "k", "g", "G"]);

// Renders the sandboxed document iframe for the document page. useBridgeHost
// serves the theme and KV; this adds comments, selection, zoom, and links.
// Painting is driven by the bridge's ready signal.
export function RenderFrame() {
  const {
    docId,
    version,
    comments,
    commentFilter,
    drafts,
    activeComment,
    startDraft,
    signIn,
    handleDocCommentClick,
    setUnanchoredComments,
    setCommentPositions,
    setCommentViewport,
    registerDocumentScroller,
    registerDocumentPrinter,
    syncCommentRail,
    handleRenderedDocumentClick,
    subscribeDocumentKV,
    reportViewport,
    moveCursor,
    subscribeCursors,
    followedCursor,
    canvasMode,
    setCanvasMode,
    placingPin,
    setPlacingPin,
    registerPinRevealer,
    setPinLabels,
    pinsShown,
    setActiveComment,
  } = useDoc();
  const config = useQuery({ queryKey: queryKeys.config(), queryFn: api.getConfig });
  const canvasEnabled = config.data?.canvas_comments_enabled === true;
  const cursorsShown = cursorsShownStore.useStore();
  const versionRef = useRef(version);
  versionRef.current = version;
  const location = useLocation();

  const token = useQuery({
    queryKey: queryKeys.render(docId, version),
    queryFn: () => api.renderToken(docId, version),
    staleTime: 4 * 60_000,
    enabled: !!version,
  });
  const { ref, frameSrc, frameOrigin, ready, postToFrame, deliverKV } = useBridgeHost(
    docId,
    token.data?.url,
    signIn,
  );
  // Paint results from a frame that is navigating away (its WindowProxy
  // survives navigation) must not bring back the state reset below.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const paintPayload = useMemo(
    () => [
      ...comments
        // Match the sidebar filter so resolved threads can also be positioned
        // beside their text when browsing All or Resolved.
        .filter(
          (c) => matchesCommentFilter(c.status, commentFilter) && !c.anchor?.point,
        )
        .map((c) => ({
          id: c.id,
          quote: c.selected_text || c.anchor?.quote,
          anchor: c.anchor,
        })),
      ...drafts
        .filter((d) => !d.anchor?.point)
        .map(({ id, quote, anchor }) => ({ id, quote, anchor })),
    ],
    [comments, commentFilter, drafts],
  );

  // Pins carry no comment text and no name beyond initials: the render frame
  // also runs the document's own scripts.
  const pinsPayload = useMemo(
    () => [
      ...drafts.flatMap((d) =>
        d.anchor?.point && d.version === version
          ? [{ id: d.id, point: d.anchor.point, draft: true }]
          : [],
      ),
      ...comments.flatMap((c) =>
        c.anchor?.point && matchesCommentFilter(c.status, commentFilter)
          ? [
              {
                id: c.id,
                point: c.anchor.point,
                initials: initialsOf(principalLabel(c.author)),
                replies: c.replies?.length ?? 0,
                resolved: c.status === "resolved",
              },
            ]
          : [],
      ),
    ],
    [comments, commentFilter, drafts, version],
  );
  // The comment last activated by a click in the frame, which needs no focus.
  const activatedInFrame = useRef<string | undefined>(undefined);
  // Text and pin anchoring report separately; the panel shows either kind.
  const unplaced = useRef({ text: new Set<string>(), pins: new Set<string>() });
  const reportUnanchored = useCallback(() => {
    const { text, pins } = unplaced.current;
    setUnanchoredComments(new Set([...text, ...pins]));
  }, [setUnanchoredComments]);

  useDocumentExport(ref, frameOrigin, ready, registerDocumentPrinter);

  useEffect(() => {
    // Anchoring results belong to the frame that produced them; drop them so
    // "highlight not found" badges never linger across version switches.
    setUnanchoredComments(new Set());
    unplaced.current = { text: new Set(), pins: new Set() };
    setCommentPositions(new Map());
    setCommentViewport({ scrollTop: 0, scrollHeight: 1 });
    setCanvasMode(false);
    setPlacingPin(false);
  }, [
    setCanvasMode,
    setPlacingPin,
    frameOrigin,
    token.data?.url,
    setUnanchoredComments,
    setCommentPositions,
    setCommentViewport,
  ]);

  useEffect(() => {
    if (!ready) return;
    if (location.hash.startsWith(TEXT_LINK_PREFIX)) {
      const anchor = parseTextLink(location.hash);
      if (anchor) postToFrame({ type: "slashdocs:navigate-text", anchor });
      else toast.error("This text link is invalid.");
      return;
    }
    let heading = location.hash.slice(1);
    try {
      heading = decodeURIComponent(heading);
    } catch {
      /* Keep literal malformed fragments. */
    }
    postToFrame({ type: "slashdocs:navigate-heading", id: heading });
  }, [location.hash, ready, postToFrame]);

  const paint = useCallback(() => {
    if (!ready) return;
    postToFrame({
      type: "slashdocs:paint",
      comments: paintPayload,
      active: activeComment,
    });
  }, [ready, paintPayload, activeComment, postToFrame]);

  // Vim scrolling works whether focus is inside the rendered document or on
  // the surrounding viewer chrome. The bridge handles the actual scroll so
  // there is still a single scroll state machine.
  useEffect(() => {
    if (!ready || !frameOrigin) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        target?.closest(
          'input,textarea,select,button,a,[contenteditable="true"],[contenteditable=""]',
        ) ||
        document.querySelector(
          '[role="dialog"][data-state="open"],[role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      const halfPage =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        ["d", "u"].includes(event.key.toLowerCase());
      if (!(plain && VIM_KEYS.has(event.key)) && !halfPage) return;
      event.preventDefault();
      postToFrame({
        type: "slashdocs:vim-key",
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        repeat: event.repeat,
      });
    };
    // A held j or k glides until its key comes up.
    const onKeyUp = (event: KeyboardEvent) => {
      if (VIM_KEYS.has(event.key)) {
        postToFrame({ type: "slashdocs:vim-key", key: event.key, up: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [ready, frameOrigin, postToFrame]);

  // ── Pinch-to-zoom: intercept trackpad pinch (wheel + ctrlKey) and apply
  // a CSS scale to the iframe instead of zooming the entire browser page.
  // Zoom is anchored to the cursor position (magnifying-glass feel).
  // Zoom-in only: shrinking below 100% leaves dead space around the document
  // and reads as a broken layout, so 1 is the floor.
  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const cursorRef = useRef({ x: 0, y: 0 });

  const scrollDocumentTo = useCallback(
    (top: number) => {
      const wrapperScrollTop = wrapperRef.current?.scrollTop || 0;
      postToFrame({
        type: "slashdocs:scroll-to",
        top: Math.max(0, (top - wrapperScrollTop) / scaleRef.current),
      });
    },
    [postToFrame],
  );

  useEffect(() => {
    registerDocumentScroller(scrollDocumentTo);
    return () => registerDocumentScroller(null);
  }, [registerDocumentScroller, scrollDocumentTo]);

  const applyZoom = useCallback(
    (deltaY: number, cursor?: { x: number; y: number }) => {
      const el = wrapperRef.current;
      if (!el) return;
      const oldScale = scaleRef.current;
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, oldScale * (1 - deltaY * 0.005)),
      );
      if (newScale === oldScale) return;

      const anchor = cursor ?? cursorRef.current;
      cursorRef.current = anchor;

      const rect = el.getBoundingClientRect();
      const cx = anchor.x - rect.left;
      const cy = anchor.y - rect.top;

      // Point in unscaled document space under cursor.
      const docX = (el.scrollLeft + cx) / oldScale;
      const docY = (el.scrollTop + cy) / oldScale;

      scaleRef.current = newScale;
      setScale(newScale);

      // After scale change, adjust scroll so the same doc point stays under cursor.
      requestAnimationFrame(() => {
        el.scrollLeft = docX * newScale - cx;
        el.scrollTop = docY * newScale - cy;
        postToFrame({ type: "slashdocs:request-comment-positions" });
      });
    },
    [postToFrame],
  );

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom(e.deltaY, { x: e.clientX, y: e.clientY });
    };
    const onMouseMove = (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    const onScroll = () => {
      postToFrame({ type: "slashdocs:request-comment-positions" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("scroll", onScroll);
    };
  }, [applyZoom, postToFrame]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameOrigin || e.origin !== frameOrigin) return;
      if (e.source !== ref.current?.contentWindow) return;
      if (e.data?.type === "slashdocs:copy-text") {
        const fragment = textLinkFragment(e.data.anchor);
        if (!fragment) {
          toast.error(
            "Select a shorter passage to copy a text link (up to 4,096 characters).",
          );
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("comment");
        url.searchParams.delete("fullscreen");
        if (versionRef.current) url.searchParams.set("version", versionRef.current);
        url.hash = fragment;
        void navigator.clipboard.writeText(url.toString()).then(
          () => toast.success("Link to text copied."),
          () => toast.error("Could not copy the text link."),
        );
      }
      if (e.data?.type === "slashdocs:text-unavailable") {
        toast.info(
          "Linked text isn't visible yet. It may be inside a tab or section you need to open.",
        );
      }
      if (e.data?.type === "slashdocs:selection") {
        const anchor = e.data.anchor as Partial<Anchor> | undefined;
        const quote = anchor?.quote ?? e.data.quote;
        const top =
          typeof e.data.top === "number" ? e.data.top * scaleRef.current : undefined;
        if (quote) startDraft({ quote, anchor, top });
      }
      if (e.data?.type === "slashdocs:viewport") {
        reportViewport(textLinkAnchor(e.data.anchor) ?? undefined);
      }
      if (e.data?.type === "slashdocs:pointer") {
        moveCursor(parseCursorSpot(e.data.spot));
      }
      if (
        e.data?.type === "slashdocs:copy-heading" &&
        typeof e.data.id === "string" &&
        e.data.id.length <= 1024
      ) {
        const url = new URL(window.location.href);
        url.searchParams.delete("comment");
        url.searchParams.delete("fullscreen");
        url.hash = e.data.id;
        void navigator.clipboard.writeText(url.toString()).then(
          () => toast.success("Heading link copied."),
          () => toast.error("Could not copy the heading link."),
        );
      }
      if (
        e.data?.type === "slashdocs:heading" &&
        typeof e.data.id === "string" &&
        e.data.id.length <= 1024
      ) {
        const url = new URL(window.location.href);
        url.searchParams.delete("comment");
        url.hash = e.data.id;
        window.history.replaceState(window.history.state, "", url);
      }
      if (e.data?.type === "slashdocs:activate" && typeof e.data.id === "string") {
        activatedInFrame.current = e.data.id;
        handleDocCommentClick(e.data.id);
      }
      if (e.data?.type === "slashdocs:canvas") setCanvasMode(true);
      if (e.data?.type === "slashdocs:canvas-place-mode")
        setPlacingPin(e.data.on === true);
      if (
        e.data?.type === "slashdocs:canvas-pin-rect" &&
        typeof e.data.id === "string"
      ) {
        const rect = parsePinRect(e.data.rect);
        if (e.data.id === watchedRef.current) setPinRect(rect);
      }
      if (e.data?.type === "slashdocs:canvas-pin-hover") {
        window.clearTimeout(hoverTimer.current);
        const rect = parsePinRect(e.data.rect);
        if (typeof e.data.id === "string" && rect) {
          const id = e.data.id.slice(0, 200);
          hoverTimer.current = window.setTimeout(() => setHover({ id, rect }), 300);
        } else setHover(undefined);
      }
      if (e.data?.type === "slashdocs:canvas-place") {
        const p = e.data.point as Record<string, unknown> | undefined;
        const frac = (n: unknown): n is number =>
          typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
        if (p && typeof p.target === "string" && frac(p.x) && frac(p.y))
          startDraft({
            quote: "",
            anchor: {
              kind: "point",
              point: { target: p.target.slice(0, 128), x: p.x, y: p.y },
            },
            label:
              typeof e.data.label === "string" ? e.data.label.slice(0, 80) : undefined,
          });
      }
      if (
        e.data?.type === "slashdocs:canvas-pins-result" &&
        Array.isArray(e.data.results) &&
        readyRef.current
      ) {
        const results = (
          e.data.results as Array<{ id?: unknown; placed?: unknown }>
        ).slice(0, 10_000);
        const labels = new Map<string, string>();
        for (const r of results as Array<{ id?: unknown; label?: unknown }>)
          if (r && typeof r.id === "string" && typeof r.label === "string")
            labels.set(r.id, r.label.slice(0, 80));
        setPinLabels(labels);
        unplaced.current.pins = new Set(
          results
            .filter((r) => r && r.placed === false && typeof r.id === "string")
            .map((r) => r.id as string),
        );
        reportUnanchored();
      }
      if (e.data?.type === "slashdocs:document-click") {
        handleRenderedDocumentClick();
      }
      if (
        e.data?.type === "slashdocs:paint-result" &&
        Array.isArray(e.data.results) &&
        readyRef.current
      ) {
        // Cap accepted entries: the render frame hosts untrusted HTML that
        // shares the bridge's origin, so a forged message must not be able to
        // allocate an unbounded Set in app state.
        const results = (
          e.data.results as Array<{ id?: unknown; anchored?: unknown }>
        ).slice(0, 10_000);
        unplaced.current.text = new Set(
          results
            .filter((r) => r && r.anchored === false && typeof r.id === "string")
            .map((r) => r.id as string),
        );
        reportUnanchored();
      }
      if (
        e.data?.type === "slashdocs:comment-scroll" &&
        typeof e.data.scrollTop === "number" &&
        Number.isFinite(e.data.scrollTop) &&
        readyRef.current
      ) {
        syncCommentRail(
          e.data.scrollTop * scaleRef.current + (wrapperRef.current?.scrollTop || 0),
        );
      }
      if (
        e.data?.type === "slashdocs:comment-positions" &&
        Array.isArray(e.data.positions) &&
        readyRef.current
      ) {
        const positions = new Map<string, { top: number; bottom: number }>();
        for (const item of e.data.positions.slice(0, 10_000)) {
          if (
            !item ||
            typeof item.id !== "string" ||
            typeof item.top !== "number" ||
            typeof item.bottom !== "number" ||
            !Number.isFinite(item.top) ||
            !Number.isFinite(item.bottom)
          ) {
            continue;
          }
          positions.set(item.id, {
            top: item.top * scaleRef.current,
            bottom: item.bottom * scaleRef.current,
          });
        }
        setCommentPositions(positions);
        if (
          typeof e.data.scrollTop === "number" &&
          typeof e.data.scrollHeight === "number" &&
          Number.isFinite(e.data.scrollTop) &&
          Number.isFinite(e.data.scrollHeight)
        ) {
          const scrollTop =
            e.data.scrollTop * scaleRef.current + (wrapperRef.current?.scrollTop || 0);
          syncCommentRail(scrollTop);
          setCommentViewport({
            scrollTop,
            scrollHeight: Math.max(1, e.data.scrollHeight * scaleRef.current),
          });
        }
      }
      if (
        e.data?.type === "slashdocs:keydown" &&
        typeof e.data.key === "string" &&
        FORWARDED_KEYS.has(e.data.key)
      ) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: e.data.key }));
      }
      if (e.data?.type === "slashdocs:zoom" && typeof e.data.deltaY === "number") {
        const frameRect = ref.current?.getBoundingClientRect();
        const cursor =
          frameRect &&
          typeof e.data.clientX === "number" &&
          typeof e.data.clientY === "number"
            ? {
                x: frameRect.left + e.data.clientX * scaleRef.current,
                y: frameRect.top + e.data.clientY * scaleRef.current,
              }
            : undefined;
        applyZoom(e.data.deltaY, cursor);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [
    ref,
    frameOrigin,
    startDraft,
    reportViewport,
    moveCursor,
    handleDocCommentClick,
    handleRenderedDocumentClick,
    setUnanchoredComments,
    setCommentPositions,
    setCommentViewport,
    syncCommentRail,
    applyZoom,
    setCanvasMode,
    setPlacingPin,
    reportUnanchored,
    setPinLabels,
  ]);

  // Canvas mode: the app enables it, the frame enters it for canvases, and
  // from then on pins, placing and focus go through these messages.
  useEffect(() => {
    if (ready && canvasEnabled) postToFrame({ type: "slashdocs:canvas-enable" });
  }, [ready, canvasEnabled, postToFrame]);
  useEffect(() => {
    if (ready && canvasMode)
      postToFrame({
        type: "slashdocs:canvas-pins",
        pins: pinsShown || placingPin ? pinsPayload : [],
        active: activeComment,
      });
  }, [
    ready,
    canvasMode,
    pinsPayload,
    activeComment,
    pinsShown,
    placingPin,
    postToFrame,
  ]);
  useEffect(() => {
    if (ready && canvasMode)
      postToFrame({ type: "slashdocs:canvas-place-mode", on: placingPin });
  }, [ready, canvasMode, placingPin, postToFrame]);
  // C places a pin from outside the canvas too, for example right after
  // posting a comment, unless the reader is typing, in a dialog, or in the
  // Esc then C chord, which toggles the panel.
  useEffect(() => {
    if (!canvasMode) return;
    let escapedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") escapedAt = Date.now();
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented)
        return;
      if (Date.now() - escapedAt <= CHORD_WINDOW_MS) return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(
          'input,textarea,select,[contenteditable="true"],[contenteditable=""]',
        ) ||
        document.querySelector(
          '[role="dialog"][data-state="open"],[role="menu"][data-state="open"]',
        )
      )
        return;
      e.preventDefault();
      setPlacingPin(!placingPin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasMode, placingPin, setPlacingPin]);
  // Esc leaves placing from anywhere, the comment box included.
  useEffect(() => {
    if (!placingPin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlacingPin(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [placingPin, setPlacingPin]);
  useEffect(() => {
    registerPinRevealer((id) => postToFrame({ type: "slashdocs:canvas-focus", id }));
    return () => registerPinRevealer(null);
  }, [registerPinRevealer, postToFrame]);
  // The popover beside the active pin: its thread, or the comment being
  // written for a new pin. The bridge reports where that pin is.
  const watchedId =
    canvasMode &&
    activeComment &&
    (drafts.some((d) => d.id === activeComment && d.anchor?.point) ||
      comments.some((c) => c.id === activeComment && c.anchor?.point))
      ? activeComment
      : undefined;
  const watchedRef = useRef(watchedId);
  watchedRef.current = watchedId;
  const [pinRect, setPinRect] = useState<PinRect | null>(null);
  useEffect(() => {
    setPinRect(null);
    if (ready && canvasMode)
      postToFrame({ type: "slashdocs:canvas-watch", id: watchedId ?? null });
  }, [ready, canvasMode, watchedId, postToFrame]);
  const [hover, setHover] = useState<{ id: string; rect: PinRect }>();
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const hovered =
    hover && hover.id !== watchedId && comments.find((c) => c.id === hover.id);

  // A thread picked in the panel brings its pin into view once; one picked
  // on the canvas is already there. A refreshed comment list moves nothing.
  const focusedComment = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ready || !canvasMode || activeComment === focusedComment.current) return;
    const pinned = comments.some((c) => c.id === activeComment && c.anchor?.point);
    if (activeComment && !pinned && comments.length === 0) return;
    focusedComment.current = activeComment;
    const fromFrame = activatedInFrame.current === activeComment;
    activatedInFrame.current = undefined;
    if (activeComment && pinned && !fromFrame)
      postToFrame({ type: "slashdocs:canvas-focus", id: activeComment });
  }, [ready, canvasMode, activeComment, comments, postToFrame]);

  // The page holds the event stream; the bridge host forwards its KV changes.
  useEffect(() => subscribeDocumentKV(deliverKV), [subscribeDocumentKV, deliverKV]);

  // Other viewers' cursors, while the reader shows them.
  useEffect(() => {
    if (!ready || !cursorsShown) return;
    const unsubscribe = subscribeCursors((cursor) =>
      postToFrame({ type: "slashdocs:cursor", cursor }),
    );
    return () => {
      unsubscribe();
      postToFrame({ type: "slashdocs:clear-cursors" });
    };
  }, [ready, cursorsShown, subscribeCursors, postToFrame]);

  // Go to a followed cursor once the frame shows its version. The effect above
  // gave the frame the cursor first.
  const followed = useRef(followedCursor);
  useEffect(() => {
    if (!ready || !followedCursor || followed.current === followedCursor) return;
    followed.current = followedCursor;
    postToFrame({ type: "slashdocs:follow-cursor", session: followedCursor.session });
  }, [ready, followedCursor, postToFrame]);

  // Push fresh paint data once the frame is ready and whenever it changes.
  useEffect(() => {
    paint();
  }, [paint]);

  // The parent (DocPage) only mounts RenderFrame when a current version
  // exists, so version is always set here.
  if (token.isLoading) return <Center>Preparing secure render…</Center>;
  if (token.error) return <Center>Could not create render token.</Center>;

  const showZoomBadge = Math.round(scale * 100) !== 100;

  return (
    <div ref={wrapperRef} className="relative h-full w-full overflow-auto">
      {/* Spacer creates the scrollable area at zoomed size */}
      <div
        style={{
          position: "relative",
          width: `${Math.max(100, scale * 100)}%`,
          height: `${Math.max(100, scale * 100)}%`,
        }}
      >
        <iframe
          ref={ref}
          title="Rendered document"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: `${100 / scale}%`,
            height: `${100 / scale}%`,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            // Paper white: theming is opt-in, so a document that ignores the
            // theme keeps its light look in a dark app.
            background: "#fff",
          }}
          src={frameSrc}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
      {watchedId && pinRect && pinsShown && (
        <PinPopover
          frameRef={ref}
          pin={pinRect}
          docId={docId}
          draft={drafts.find((d) => d.id === watchedId)}
          comment={comments.find((c) => c.id === watchedId)}
          onClose={() => setActiveComment(undefined)}
        />
      )}
      {hover && hovered && pinsShown && (
        <PinPreview frameRef={ref} pin={hover.rect} comment={hovered} />
      )}
      {showZoomBadge && (
        <button
          type="button"
          onClick={() => {
            scaleRef.current = 1;
            setScale(1);
            const wrapper = wrapperRef.current;
            if (wrapper) {
              wrapper.scrollLeft = 0;
              wrapper.scrollTop = 0;
            }
            window.requestAnimationFrame(() => {
              postToFrame({ type: "slashdocs:request-comment-positions" });
            });
          }}
          className="sticky bottom-3 left-[calc(100%-3.5rem)] z-10 rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg-muted)] shadow-md ring-1 ring-[var(--color-border)] transition-opacity hover:text-[var(--color-fg)]"
          title="Reset zoom"
        >
          {Math.round(scale * 100)}%
        </button>
      )}
    </div>
  );
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((x) => x[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

function parsePinRect(value: unknown): PinRect | null {
  const r = value as Record<string, unknown> | null;
  const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return r && num(r.left) && num(r.top) && num(r.width) && num(r.height)
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : null;
}
