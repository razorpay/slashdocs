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
import { CHORD_KEYS } from "@/lib/esc-chord";
import { cursorsShownStore, parseCursorSpot } from "@/lib/live-cursors";
import { useDocumentExport } from "./use-document-export";
import { useDoc } from "./doc-context";
import { useBridgeHost } from "./use-bridge-host";
import { parseOutline } from "@/lib/outline";

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
    registerHeadingNavigator,
    setOutline,
    setActiveHeading,
    syncCommentRail,
    handleRenderedDocumentClick,
    subscribeDocumentKV,
    reportViewport,
    moveCursor,
    subscribeCursors,
    followedCursor,
  } = useDoc();
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
        .filter((c) => matchesCommentFilter(c.status, commentFilter))
        .map((c) => ({
          id: c.id,
          quote: c.selected_text || c.anchor?.quote,
          anchor: c.anchor,
        })),
      ...drafts.map(({ id, quote, anchor }) => ({ id, quote, anchor })),
    ],
    [comments, commentFilter, drafts],
  );

  useDocumentExport(ref, frameOrigin, ready, registerDocumentPrinter);

  useEffect(() => {
    // Anchoring results belong to the frame that produced them; drop them so
    // "highlight not found" badges never linger across version switches.
    setUnanchoredComments(new Set());
    setCommentPositions(new Map());
    setCommentViewport({ scrollTop: 0, scrollHeight: 1 });
  }, [
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

  // The outline goes to a heading even when it is already in the URL, so the
  // fragment is set without the navigation the hash effect above would make.
  const navigateHeading = useCallback(
    (id: string) => {
      const url = new URL(window.location.href);
      url.searchParams.delete("comment");
      url.hash = id;
      window.history.replaceState(window.history.state, "", url);
      postToFrame({ type: "slashdocs:navigate-heading", id });
    },
    [postToFrame],
  );

  useEffect(() => {
    registerHeadingNavigator(navigateHeading);
    return () => registerHeadingNavigator(null);
  }, [registerHeadingNavigator, navigateHeading]);

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
      if (e.data?.type === "slashdocs:outline") {
        setOutline(parseOutline(e.data.headings));
      }
      if (
        e.data?.type === "slashdocs:outline-active" &&
        typeof e.data.id === "string" &&
        e.data.id.length <= 1024
      ) {
        setActiveHeading(e.data.id);
      }
      if (e.data?.type === "slashdocs:activate" && typeof e.data.id === "string") {
        handleDocCommentClick(e.data.id);
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
        setUnanchoredComments(
          new Set(
            results
              .filter((r) => r && r.anchored === false && typeof r.id === "string")
              .map((r) => r.id as string),
          ),
        );
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
    setOutline,
    setActiveHeading,
    applyZoom,
  ]);

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
