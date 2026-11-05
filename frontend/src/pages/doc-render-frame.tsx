import {
  parseTextLink,
  textLinkAnchor,
  textLinkFragment,
  TEXT_LINK_PREFIX,
} from "../../bridge/text-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Anchor } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { COMMENT_STATUS } from "@/lib/constants";
import { Center, RetryButton } from "@/components/ui/misc";
import { ErrorState } from "@/components/error-state";
import { errorMessage } from "@/lib/errors";
import { CHORD_KEYS } from "@/lib/esc-chord";
import { cursorsShownStore, parseCursorSpot } from "@/lib/live-cursors";
import { createPersistentStore } from "@/lib/persistent-store";
import { agentRequestBody } from "@/lib/agent-request";
import { principalColor } from "@/lib/principals";
import { useDocumentExport } from "./use-document-export";
import { useDoc } from "./doc-context";
import { useBridgeHost } from "./use-bridge-host";
import { useFrameMessage } from "./use-frame-message";
import { useTextAutosave } from "./use-text-autosave";
import { typingOrInLayer, useCommentPins } from "./use-comment-pins";
import { CommentPopovers } from "./doc-comment-popover";
import type { TextEditResult } from "./doc-context";
import type { Render } from "@/lib/script-literals";
import type { ProbeResult } from "../../bridge/script-text";
import type {
  ChildRef,
  Locator,
  Piece,
  Region,
  ScriptChange,
} from "../../bridge/source-pieces";

const FORWARDED_KEYS = new Set<string>([
  "Escape",
  "?",
  ...CHORD_KEYS.map((item) => item.key),
]);
const VIM_KEYS = new Set(["j", "k", "g", "G"]);

const editHintSeen = createPersistentStore<boolean>("slashdocs:edit-hint-seen", false);
const editHint = () =>
  matchMedia("(pointer: coarse)").matches
    ? "Type to edit. Tap Done to leave the text."
    : "Type to edit. Press Esc to leave the text.";

// Renders the sandboxed document iframe for the document page. useBridgeHost
// serves the theme and KV; this adds comments, selection, zoom, and links.
// Painting is driven by the bridge's ready signal.
export function RenderFrame({
  chordArmed = false,
  cover = 0,
  onCrowded,
}: {
  // The Esc chord waits for a letter. The document gives the letter to it
  // then, and not to its own keys.
  chordArmed?: boolean;
  // A panel covers this many pixels at the right. The document glides left
  // from under it when its left margin has room, or else onCrowded asks for
  // room beside the panel.
  cover?: number;
  onCrowded?: () => void;
}) {
  const {
    docId,
    version,
    comments,
    drafts,
    activeComment,
    startDraft,
    principal,
    signIn,
    handleDocCommentClick,
    setUnanchoredComments,
    setMovedPins,
    setCommentPositions,
    setDocumentHeight,
    registerDocumentScroller,
    registerDocumentPrinter,
    handleRenderedDocumentClick,
    subscribeDocumentKV,
    reportViewport,
    moveCursor,
    subscribeCursors,
    followedCursor,
    onUnfollowCursor,
    editable,
    setSaveState,
    setText,
    stayOnVersion,
    showLatest,
  } = useDoc();
  const cursorsShown = cursorsShownStore.useStore();
  const versionRef = useRef(version);
  versionRef.current = version;
  const location = useLocation();
  const q = useQueryClient();

  // The last version saved from the frame is already on screen, so moving to
  // it keeps the frame on the version it loaded: the editor keeps its caret
  // and scroll. Any other version, an earlier save too, loads the frame
  // again, as does a reload.
  const [kept, setKept] = useState<{ loaded: string; saved: string }>();
  const [reloads, setReloads] = useState(0);
  const frameVersion = kept?.saved === version ? kept.loaded : version;
  const previousVersion = useRef(version);
  useEffect(() => {
    const moved = previousVersion.current !== version;
    previousVersion.current = version;
    if (!moved || !kept || kept.saved === version) return;
    setKept(undefined);
    // The frame holds edits on top of the version it loaded.
    if (version === kept.loaded) setReloads((n) => n + 1);
  }, [kept, version]);
  const loaded = useMemo(
    () => ({ version: frameVersion, load: reloads }),
    [frameVersion, reloads],
  );

  const token = useQuery({
    queryKey: queryKeys.render(docId, frameVersion),
    queryFn: () => api.renderToken(docId, frameVersion),
    staleTime: 4 * 60_000,
    enabled: !!frameVersion,
  });
  const { ref, frameSrc, frameOrigin, ready, postToFrame, deliverKV } = useBridgeHost(
    docId,
    token.data?.url && reloadURL(token.data.url, reloads),
    signIn,
  );
  // Paint results from a frame that is navigating away (its WindowProxy
  // survives navigation) must not bring back the state reset below.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Open threads on text are highlighted, and a resolved one while it is
  // open, as from the comments list. Point comments are pins instead.
  const paintPayload = useMemo(
    () => [
      ...comments
        .filter(
          (c) =>
            !c.anchor?.point &&
            (c.status !== COMMENT_STATUS.resolved || c.id === activeComment),
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
    [comments, activeComment, drafts],
  );

  useDocumentExport(ref, frameOrigin, ready, registerDocumentPrinter);

  useEffect(() => {
    // Anchoring results belong to the frame that produced them; drop them so
    // "highlight not found" badges never linger across version switches.
    setUnanchoredComments("text", new Set());
    setUnanchoredComments("pins", new Set());
    setMovedPins(new Set());
    setCommentPositions(new Map());
    setDocumentHeight(1);
  }, [
    frameOrigin,
    token.data?.url,
    setUnanchoredComments,
    setMovedPins,
    setCommentPositions,
    setDocumentHeight,
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
  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:text-editing", on: editable });
  }, [ready, editable, postToFrame]);

  // The frame hands over its text changes on request.
  const textCollects = useRef(
    new Map<string, (result: TextEditResult | undefined) => void>(),
  );
  const takeTextEdits = useCallback(
    () =>
      new Promise<TextEditResult>((resolve, reject) => {
        const requestId = `text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
          textCollects.current.delete(requestId);
          reject(new Error("The document did not report its changes."));
        }, 5000);
        textCollects.current.set(requestId, (result) => {
          window.clearTimeout(timer);
          if (result) resolve(result);
          else reject(new Error("The document reported changes that cannot be read."));
        });
        postToFrame({ type: "slashdocs:text-collect", requestId });
      }),
    [postToFrame],
  );
  // The frame renders a changed source in a hidden frame on request. A probe
  // waits for its load for at most five seconds, so this gives it ten.
  const probes = useRef(new Map<string, (result: ProbeResult | undefined) => void>());
  const probe = useCallback<Render>(
    (html, locator, strings) =>
      new Promise((resolve, reject) => {
        const requestId = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
          probes.current.delete(requestId);
          reject(new Error("The document did not render the change."));
        }, 10_000);
        probes.current.set(requestId, (result) => {
          window.clearTimeout(timer);
          if (result) resolve(result);
          else
            reject(
              new Error(
                "The document rendered the change in a form that cannot be read.",
              ),
            );
        });
        postToFrame({ type: "slashdocs:probe", requestId, html, locator, strings });
      }),
    [postToFrame],
  );
  // The scroll of the frame at its last report, which a load for a save
  // keeps.
  const frameTop = useRef(0);
  const restoreTop = useRef<number | undefined>(undefined);
  const {
    changed: textChanged,
    drafted: textDrafted,
    scriptEditable,
    focused: textFocused,
  } = useTextAutosave({
    docId,
    loaded,
    take: takeTextEdits,
    setState: setSaveState,
    // A clean save holds what is on screen, so the editor stays on it rather
    // than on the latest, which may hold changes from elsewhere.
    onSaved: (saved, clean) => {
      if (clean) {
        setKept((k) => ({ loaded: k?.loaded ?? frameVersion, saved }));
        stayOnVersion(saved);
      } else stayOnVersion();
      for (const queryKey of [
        queryKeys.document(docId),
        queryKeys.versions(docId),
        queryKeys.approvalsAll(docId),
        queryKeys.documents(),
      ]) {
        q.invalidateQueries({ queryKey });
      }
    },
    // A load right after a save shows the version that it made: the document
    // stream must not keep the frame on the version before it.
    reload: (saved) => {
      if (saved) stayOnVersion(saved);
      else showLatest();
      setKept(undefined);
      restoreTop.current = frameTop.current;
      setReloads((n) => n + 1);
    },
    undo: () => postToFrame({ type: "slashdocs:text-undo" }),
    probe,
    replaceText: (from, to) =>
      postToFrame({ type: "slashdocs:script-replace", from, to }),
  });
  // Each load flashes what changed since the reader saw the document last,
  // after the scroll, so that the flash is where they look.
  useEffect(() => {
    if (!ready) return;
    if (restoreTop.current !== undefined)
      postToFrame({ type: "slashdocs:scroll-to", top: restoreTop.current });
    restoreTop.current = undefined;
    postToFrame({ type: "slashdocs:show-changes" });
  }, [ready, postToFrame]);

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
        if (quote) startDraft({ quote, anchor });
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
        handleDocCommentClick(e.data.id);
      }
      if (e.data?.type === "slashdocs:document-click") {
        handleRenderedDocumentClick();
        // An editor learns once, at the first click in the text, that it
        // types and how to leave it.
        if (editable && !editHintSeen.read()) {
          editHintSeen.write(true);
          toast.info(editHint(), { id: "edit-hint", duration: 8000 });
        }
      }
      if (e.data?.type === "slashdocs:unfollowed") {
        onUnfollowCursor?.();
      }
      // The document reloaded itself in place: it has no highlights until it
      // is painted again.
      if (e.data?.type === "slashdocs:ready" && readyRef.current) {
        paintRef.current();
      }
      if (/^slashdocs:text-(changes|draft)$/.test(e.data?.type)) {
        if (isOffset(e.data.top)) frameTop.current = e.data.top;
        const result = parseTextEditResult(e.data);
        if (e.data.type === "slashdocs:text-draft") {
          if (result) textDrafted(result);
        } else if (typeof e.data.requestId === "string") {
          const resolve = textCollects.current.get(e.data.requestId);
          textCollects.current.delete(e.data.requestId);
          resolve?.(result);
        }
      }
      if (
        e.data?.type === "slashdocs:probe-result" &&
        typeof e.data.requestId === "string"
      ) {
        const resolve = probes.current.get(e.data.requestId);
        probes.current.delete(e.data.requestId);
        resolve?.(parseProbeResult(e.data));
      }
      if (
        e.data?.type === "slashdocs:script-text" &&
        typeof e.data.requestId === "string" &&
        typeof e.data.text === "string"
      ) {
        const { requestId } = e.data;
        void scriptEditable(e.data.text).then(
          (editable) =>
            postToFrame({ type: "slashdocs:script-text-result", requestId, editable }),
          () =>
            postToFrame({
              type: "slashdocs:script-text-result",
              requestId,
              editable: false,
              failed: true,
            }),
        );
      }
      // The reader cannot change this script text here, so a comment asks an
      // agent to.
      if (e.data?.type === "slashdocs:ask-agent") {
        const anchor = e.data.anchor as Partial<Anchor> | undefined;
        if (anchor?.quote)
          startDraft({
            quote: anchor.quote,
            anchor,
            body: agentRequestBody(anchor.quote),
          });
      }
      if (e.data?.type === "slashdocs:text-focus") {
        if (e.data.on === true) void textFocused();
        setText({
          focused: e.data.on === true,
          leave: () => postToFrame({ type: "slashdocs:leave-text" }),
        });
      }
      if (e.data?.type === "slashdocs:text-dirty" && typeof e.data.count === "number") {
        textChanged(e.data.count);
      }
      if (e.data?.type === "slashdocs:text-refused") {
        toast.info(REFUSALS.get(e.data.reason) ?? "This change does not work here.", {
          id: "text-refused",
        });
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
          "text",
          new Set(
            results
              .filter((r) => r && r.anchored === false && typeof r.id === "string")
              .map((r) => r.id as string),
          ),
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
          typeof e.data.scrollHeight === "number" &&
          Number.isFinite(e.data.scrollHeight)
        )
          setDocumentHeight(Math.max(1, e.data.scrollHeight * scaleRef.current));
      }
      if (
        e.data?.type === "slashdocs:keydown" &&
        typeof e.data.key === "string" &&
        FORWARDED_KEYS.has(e.data.key)
      ) {
        // It comes to the app as a key on the page does: the window's capture
        // listeners, as the Esc chord's, take it first, and may keep it.
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: e.data.key,
            bubbles: true,
            cancelable: true,
          }),
        );
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
    setDocumentHeight,
    applyZoom,
    editable,
    setText,
    textChanged,
    textDrafted,
    textFocused,
    scriptEditable,
    postToFrame,
    onUnfollowCursor,
  ]);

  useCommentPins(ref, frameOrigin, ready, postToFrame);

  // A signed-in reader chats at their cursor in their cursor color. A
  // signed-out reader sees the chat of others but cannot send.
  const chatColor = principal && !signIn ? principalColor(principal) : undefined;
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:cursor-chat", color: chatColor });
  }, [ready, chatColor, postToFrame]);
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:chord", armed: chordArmed });
  }, [ready, chordArmed, postToFrame]);
  const [shift, setShift] = useState(0);
  // The room that the document leaves shows its paper, not the app.
  const [paper, setPaper] = useState<string>();
  const coverRef = useRef(cover);
  coverRef.current = cover;
  const onCrowdedRef = useRef(onCrowded);
  onCrowdedRef.current = onCrowded;
  useEffect(() => {
    setShift(0);
    if (ready && cover)
      postToFrame({ type: "slashdocs:room", cover: cover / scaleRef.current });
  }, [ready, cover, postToFrame]);
  useFrameMessage(ref, frameOrigin, ready, (data) => {
    if (data.type !== "slashdocs:room" || !coverRef.current) return;
    if (typeof data.paper === "string" && CSS.supports("color", data.paper))
      setPaper(data.paper);
    if (typeof data.shift === "number") setShift(data.shift * scaleRef.current);
    else onCrowdedRef.current?.();
  });

  // "/" opens cursor chat at the pointer even when the app has the focus, as
  // right after following someone from the bar. The document opens it only
  // when the pointer is over it. The key is taken, so that it does not also
  // open the browser's quick find, which takes the focus from the chat.
  useEffect(() => {
    if (!ready || !chatColor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingOrInLayer(e))
        return;
      e.preventDefault();
      postToFrame({ type: "slashdocs:open-cursor-chat" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, chatColor, postToFrame]);

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

  // Go to a viewer, or follow them, once the frame shows their version, or
  // stop. The effect above gave the frame the cursor first.
  const followed = useRef(followedCursor);
  useEffect(() => {
    if (!ready || followed.current === followedCursor) return;
    followed.current = followedCursor;
    postToFrame(
      followedCursor
        ? { type: "slashdocs:follow-cursor", ...followedCursor }
        : { type: "slashdocs:unfollow-cursor" },
    );
  }, [ready, followedCursor, postToFrame]);

  // Push fresh paint data once the frame is ready and whenever it changes.
  useEffect(() => {
    paint();
  }, [paint]);

  // The parent (DocPage) only mounts RenderFrame when a current version
  // exists, so version is always set here.
  if (token.isLoading) return <Center>Preparing secure render…</Center>;
  if (token.error)
    return (
      <ErrorState
        title="Could not open the document"
        description={errorMessage(token.error)}
        action={<RetryButton query={token} />}
      />
    );

  const showZoomBadge = Math.round(scale * 100) !== 100;

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-auto"
      style={{ background: paper }}
    >
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
            translate: `${-shift}px 0`,
            // Paper white: theming is opt-in, so a document that ignores the
            // theme keeps its light look in a dark app.
            background: "#fff",
          }}
          className="transition-[translate] duration-200 ease-out"
          src={frameSrc}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
      <CommentPopovers
        frame={ref}
        bounds={wrapperRef}
        origin={frameOrigin}
        ready={ready}
        postToFrame={postToFrame}
      />
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

// reloadURL makes a render URL that loads the frame again, as the same URL
// would not.
function reloadURL(url: string, reloads: number): string {
  if (!reloads) return url;
  return `${url}${url.includes("?") ? "&" : "?"}slashdocs_reload=${reloads}`;
}

// Messages for the reasons the frame gives when it refuses an edit.
const REFUSALS = new Map([
  // The hint at script text says the same.
  ["script", "A script on the page writes this text."],
  [
    "crosses-script",
    "The selection includes content that a script makes. Select less text.",
  ],
  ["drop", "Dragging content into the document does not work. Copy and paste it."],
  ["format", "Only bold, italic, links and lists can change here."],
  ["list", "Only paragraphs can become a list."],
  ["plain-text", "Text from a script takes plain words only."],
]);

// parseTextEditResult reads a text-changes message. The frame hosts untrusted
// HTML on the bridge's origin, so the message is checked, not trusted: a
// region that is not made of the numbers and strings that source-pieces.ts
// describes makes the whole result unreadable.
function parseTextEditResult(
  data: Record<string, unknown>,
): TextEditResult | undefined {
  const { regions, scripts } = data;
  return Array.isArray(regions) &&
    regions.every(isRegion) &&
    Array.isArray(scripts) &&
    scripts.every(isScriptChange)
    ? { regions, scripts }
    : undefined;
}

// parseProbeResult reads a probe-result message, checked as the text
// changes are.
function parseProbeResult(data: Record<string, unknown>): ProbeResult | undefined {
  const { text, counts, texts, errors } = data;
  return (text === null || typeof text === "string") &&
    Array.isArray(counts) &&
    counts.every(isOffset) &&
    isOffset(texts) &&
    isOffset(errors)
    ? { text, counts, texts, errors }
    : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const isOffset = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const isChildRef = (v: unknown): v is ChildRef =>
  isObject(v) && isOffset(v.parent) && isOffset(v.index);
const isPieces = (v: unknown): v is Piece[] => Array.isArray(v) && v.every(isPiece);

const isLocator = (v: unknown): v is Locator =>
  isObject(v) &&
  (v.at === null || isOffset(v.at)) &&
  Array.isArray(v.path) &&
  v.path.every(isOffset);
const isScriptChange = (v: unknown): v is ScriptChange =>
  isObject(v) &&
  isLocator(v.locator) &&
  typeof v.before === "string" &&
  typeof v.after === "string";

function isRegion(v: unknown): v is Region {
  return (
    isObject(v) &&
    isOffset(v.from) &&
    isOffset(v.to) &&
    isPieces(v.pieces) &&
    Array.isArray(v.removed) &&
    v.removed.every(isOffset)
  );
}

function isPiece(p: unknown): boolean {
  if (!isObject(p)) return false;
  if ("keep" in p) return isOffset(p.keep);
  if ("keepChild" in p) return isChildRef(p.keepChild);
  if ("text" in p) {
    return typeof p.text === "string" && (p.was === undefined || isChildRef(p.was));
  }
  if ("element" in p) return isOffset(p.element) && isPieces(p.children);
  return (
    typeof p.open === "string" && typeof p.close === "string" && isPieces(p.children)
  );
}
