import {
  parseTextLink,
  textLinkAnchor,
  textLinkFragment,
  TEXT_LINK_PREFIX,
} from "../../bridge/text-link";
import { isCaret, type Caret } from "../../bridge/caret";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type Anchor } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { COMMENT_STATUS } from "@/lib/constants";
import { Center, CodeBlock } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadError } from "@/components/error-state";
import { CHORD_KEYS } from "@/lib/esc-chord";
import { cursorsShownStore, parseCursorSpot } from "@/lib/live-cursors";
import { agentRequestBody } from "@/lib/agent-request";
import { principalColor } from "@/lib/principals";
import { randomId } from "@/lib/uuid";
import { useDocumentExport } from "./use-document-export";
import { useDoc } from "./doc-context";
import { useBridgeHost } from "./use-bridge-host";
import { useFrameMessage } from "./use-frame-message";
import { useLiveText } from "./use-live-text";
import { typingOrInLayer, useCommentPins } from "./use-comment-pins";
import { CommentPopovers } from "./doc-comment-popover";
import { useCommentJumps } from "./use-comment-jumps";
import type { TextEditResult, TextPatchResult } from "./doc-context";
import type { Render } from "@/lib/script-literals";
import type { ProbeResult } from "../../bridge/script-text";
import type {
  ChildRef,
  Locator,
  Patch,
  Piece,
  Region,
  ScriptChange,
} from "../../bridge/source-pieces";

const FORWARDED_KEYS = new Set<string>([
  "Escape",
  "?",
  "e",
  ...CHORD_KEYS.map((item) => item.key),
  // The keys that go from thread to thread.
  ..."jknpJ",
]);
const VIM_KEYS = new Set(["j", "k", "g", "G"]);

// How long a control in the document shows that it copied.
const COPIED_MS = 1500;
// How long a load of the frame waits for the frame on screen to tell its
// scroll. A frame that failed tells nothing.
const SCROLL_MS = 500;

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
    holdCursor,
    subscribeCursors,
    followedCursor,
    onUnfollowCursor,
    editing,
    registerLiveText,
    setSaveState,
    setFrameReady,
    frameShows,
    frameLoad,
    reloadFrame,
    onPage,
    liveLoads,
    latest,
    live,
    event,
    madeBy,
    holdUpdate,
    leaving,
  } = useDoc();
  const cursorsShown = cursorsShownStore.useStore();
  const versionRef = useRef(version);
  versionRef.current = version;
  const location = useLocation();

  // What the frame shows: the live document, or the preview of a version.
  // A frame that follows the live document loads the version that is
  // current then, at the seq that the render token names. A later version
  // of the document does not load it again: the frame follows the document
  // in place. Each load asks for a new token, because a token renders one
  // seq, and so does each frame: a frame that mounts again, as full screen
  // does, loads again. A token is never asked for again by itself, because
  // its URL would load the frame under the text of the reader. The frame on
  // screen stays until the token of the next load of the same document
  // comes.
  const showing = live ? "live" : version;
  const [frame] = useState(randomId);
  const token = useQuery({
    queryKey: queryKeys.render(docId, showing, frameLoad, frame),
    queryFn: async () => {
      const { url, seq } = await api.renderToken(docId, version);
      return { url: reloadURL(url, frameLoad), seq, version };
    },
    staleTime: Infinity,
    enabled: !!version,
    placeholderData: keepPreviousData,
  });
  const loaded = { version: "", ...token.data };
  const {
    ref,
    frameSrc,
    frameOrigin,
    ready,
    failed,
    onLoad,
    retry,
    postToFrame,
    deliverKV,
  } = useBridgeHost(docId, token.data?.url, { signIn, refresh: token.refetch });
  // The bar says that the reader can edit only once the frame shows the text.
  // A frame that loads again what it shows, as after a patch that failed,
  // keeps the bar as it was, unless that load fails.
  const [readyFor, setReadyFor] = useState<string>();
  useEffect(() => {
    if (ready) setReadyFor(showing);
  }, [ready, showing]);
  const usable = ready || (readyFor === showing && !failed && !token.error);
  useEffect(() => {
    setFrameReady(usable);
    return () => setFrameReady(false);
  }, [usable, setFrameReady]);
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
          unread: c.unread,
          leaving: c.id === leaving,
        })),
      ...drafts
        .filter((d) => !d.anchor?.point)
        .map(({ id, quote, anchor }) => ({ id, quote, anchor })),
    ],
    [comments, activeComment, drafts, leaving],
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
    if (ready) postToFrame({ type: "slashdocs:text-editing", on: editing });
  }, [ready, editing, postToFrame]);

  // The frame answers a request by its id. A request that gets no answer,
  // or one that cannot be read, fails.
  const requests = useRef(new Map<string, (result: unknown) => void>());
  const ask = useCallback(
    <T,>(message: Record<string, unknown>, timeout = 5000) =>
      new Promise<T>((resolve, reject) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = window.setTimeout(() => {
          requests.current.delete(requestId);
          reject(new Error("The document did not answer."));
        }, timeout);
        requests.current.set(requestId, (result) => {
          window.clearTimeout(timer);
          requests.current.delete(requestId);
          if (result) resolve(result as T);
          else reject(new Error("The document gave an answer that cannot be read."));
        });
        postToFrame({ ...message, requestId });
      }),
    [postToFrame],
  );
  // The frame hands over its text changes on request.
  const takeTextEdits = useCallback(
    (timeout?: number) =>
      ask<TextEditResult>({ type: "slashdocs:text-collect" }, timeout),
    [ask],
  );
  // The frame shows the text of other people in place. It gives no answer
  // to a patch that it cannot read.
  const patchFrame = useCallback(
    (patches: Patch[], edits: number, flash: boolean, hold: boolean) =>
      ask<TextPatchResult>({
        type: "slashdocs:text-patch",
        patches,
        edits,
        flash,
        ask: hold,
      }),
    [ask],
  );
  // The frame describes the text of the highlight of a comment on request,
  // on the seq that it shows.
  const shownSeq = useRef<number>(undefined);
  const showsAt = useCallback<typeof frameShows>(
    (seq, version) => {
      shownSeq.current = seq;
      frameShows(seq, version);
    },
    [frameShows],
  );
  const anchorOf = useCallback(
    (id: string) =>
      ask<{ anchor?: Anchor }>({ type: "slashdocs:anchor", id }).then(
        ({ anchor }) => anchor && { anchor, seq: shownSeq.current },
      ),
    [ask],
  );
  // The frame renders a changed source in a hidden frame on request. A probe
  // waits for its load for at most five seconds, so this gives it ten.
  const probe = useCallback<Render>(
    (html, locator, strings) =>
      ask({ type: "slashdocs:probe", html, locator, strings }, 10_000),
    [ask],
  );
  // The scroll and the selection of the frame at its last report, which a
  // load that the hook asks for keeps: the reader stays where they are in
  // the document, and their caret stays at its characters.
  const frameTop = useRef(0);
  const restoreTop = useRef<number | undefined>(undefined);
  const frameCaret = useRef<Caret | null>(null);
  const restoreCaret = useRef<Caret | null>(null);
  const {
    changed: textChanged,
    scrolled: textScrolled,
    restarted: frameRestarted,
    scriptEditable,
    focused: textFocused,
    settle,
    showUpdate,
  } = useLiveText({
    docId,
    owner: principal?.id,
    signIn,
    loaded,
    latest,
    event,
    // The frame that stays while the next token loads follows nothing.
    live: live && ready && !token.isPlaceholderData,
    editing,
    onPage,
    loads: liveLoads,
    take: () => takeTextEdits(),
    patch: patchFrame,
    setState: setSaveState,
    holdCursor,
    frameShows: showsAt,
    holdUpdate,
    madeBy,
    reload: () => {
      // The frame takes no more keys: the server holds its text, and a key
      // from now on would go with the frame. The answer of the frame tells
      // its scroll.
      postToFrame({ type: "slashdocs:text-editing", on: false });
      void takeTextEdits(SCROLL_MS)
        .catch(() => undefined)
        .then(() => {
          restoreTop.current = frameTop.current;
          restoreCaret.current = frameCaret.current;
          reloadFrame();
        });
    },
    probe,
    replaceText: (from, to) =>
      postToFrame({ type: "slashdocs:script-replace", from, to }),
  });
  useEffect(() => {
    registerLiveText({ settle, showUpdate, anchorOf });
    return () => registerLiveText(null);
  }, [registerLiveText, settle, showUpdate, anchorOf]);
  // Each load flashes what changed since the reader saw the document last,
  // after the scroll, so that the flash is where they look.
  useEffect(() => {
    if (!ready) return;
    if (restoreTop.current !== undefined)
      postToFrame({
        type: "slashdocs:scroll-to",
        top: restoreTop.current,
        ...(restoreCaret.current && { caret: restoreCaret.current }),
      });
    restoreTop.current = undefined;
    restoreCaret.current = null;
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
  // What a screen reader hears of a control in the document that confirms
  // in place.
  const [said, setSaid] = useState("");
  // A heading link that the browser did not let the app copy.
  const [headingLink, setHeadingLink] = useState<string>();
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(""), COPIED_MS);
    return () => clearTimeout(timer);
  }, [said]);
  const scaleRef = useRef(1);
  const cursorRef = useRef({ x: 0, y: 0 });

  // The page scrolls the document to a place, in pixels of the page.
  useEffect(() => {
    registerDocumentScroller({
      to: (top) => {
        const wrapperScrollTop = wrapperRef.current?.scrollTop || 0;
        postToFrame({
          type: "slashdocs:scroll-to",
          top: Math.max(0, (top - wrapperScrollTop) / scaleRef.current),
        });
      },
    });
    return () => registerDocumentScroller(null);
  }, [registerDocumentScroller, postToFrame]);

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
      // The frame tells its view when a scroll rests.
      if (e.data?.type === "slashdocs:viewport") {
        reportViewport(textLinkAnchor(e.data.anchor) ?? undefined);
        textScrolled();
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
        // The # control says Copied, over its heading. A toast would cover
        // the words. When the browser refuses the copy, the link shows to
        // copy by hand, and the address has the heading too.
        const id = e.data.id;
        void navigator.clipboard.writeText(url.toString()).then(
          () => {
            postToFrame({ type: "slashdocs:heading-copied", id });
            setSaid("Heading link copied.");
          },
          () => {
            setHeadingLink(url.toString());
            showHeading(id);
          },
        );
      }
      if (
        e.data?.type === "slashdocs:heading" &&
        typeof e.data.id === "string" &&
        e.data.id.length <= 1024
      )
        showHeading(e.data.id);
      if (e.data?.type === "slashdocs:activate" && typeof e.data.id === "string") {
        handleDocCommentClick(e.data.id);
      }
      if (e.data?.type === "slashdocs:document-click") {
        handleRenderedDocumentClick();
      }
      if (e.data?.type === "slashdocs:unfollowed") {
        onUnfollowCursor?.();
      }
      // The document loaded itself again in place, as some do on a theme
      // change. It has no highlights, and it shows the source that the page
      // loaded, at its seq: it gets its highlights, and the page follows
      // the document again from that seq.
      if (e.data?.type === "slashdocs:ready" && readyRef.current) {
        paintRef.current();
        frameRestarted();
      }
      const answer = (result: unknown) =>
        requests.current.get(e.data.requestId)?.(result);
      if (/^slashdocs:text-(changes|draft|patched)$/.test(e.data?.type)) {
        if (isOffset(e.data.top)) frameTop.current = e.data.top;
        if (e.data.type !== "slashdocs:text-draft")
          frameCaret.current = isCaret(e.data.caret) ? e.data.caret : null;
        const result = parseTextEditResult(e.data);
        // The frame sends its edits after each change of the reader.
        if (e.data.type === "slashdocs:text-draft") textChanged(result);
        else if (e.data.type === "slashdocs:text-changes") answer(result);
        else
          answer(
            result && {
              ...result,
              ok: e.data.ok === true,
              stale: e.data.stale === true,
              withdrawn: e.data.withdrawn === true,
            },
          );
      }
      if (e.data?.type === "slashdocs:probe-result") answer(parseProbeResult(e.data));
      if (e.data?.type === "slashdocs:anchor-result")
        answer(
          e.data.anchor === null
            ? {}
            : isAnchor(e.data.anchor) && { anchor: e.data.anchor },
        );
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
      if (e.data?.type === "slashdocs:text-focus" && e.data.on === true)
        void textFocused();
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
    textChanged,
    textScrolled,
    textFocused,
    frameRestarted,
    scriptEditable,
    postToFrame,
    onUnfollowCursor,
  ]);

  useCommentPins(ref, frameOrigin, ready, postToFrame);
  useCommentJumps(ready, postToFrame);

  // A signed-in reader chats at their cursor in their cursor color. A
  // signed-out reader sees the chat of others but cannot send.
  const chatColor = principal && !signIn ? principalColor(principal) : undefined;
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:cursor-chat", color: chatColor });
  }, [ready, chatColor, postToFrame]);
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:chord", armed: chordArmed });
  }, [ready, chordArmed, postToFrame]);
  const onCrowdedRef = useRef(onCrowded);
  onCrowdedRef.current = onCrowded;
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:room", cover: cover / scaleRef.current });
  }, [ready, cover, postToFrame]);
  useFrameMessage(ref, frameOrigin, ready, (data) => {
    if (data.type === "slashdocs:room" && data.crowded === true)
      onCrowdedRef.current?.();
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
  if (token.isPending) return <Center>Preparing secure render…</Center>;
  if (token.error || failed)
    return (
      <Center>
        <LoadError
          title="Could not open the document"
          error={token.error}
          query={token.error ? token : retry}
        />
      </Center>
    );

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
          onLoad={onLoad}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
      <CommentPopovers
        frame={ref}
        bounds={wrapperRef}
        panel={cover}
        origin={frameOrigin}
        ready={ready}
        postToFrame={postToFrame}
      />
      <p role="status" className="sr-only">
        {said}
      </p>
      <Dialog
        open={!!headingLink}
        onOpenChange={(open) => !open && setHeadingLink(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the heading link</DialogTitle>
            <DialogDescription>
              The browser did not let the app copy it. Select the link and copy it.
            </DialogDescription>
          </DialogHeader>
          <CodeBlock copy="always" wrap onCopied={() => setHeadingLink(undefined)}>
            {headingLink ?? ""}
          </CodeBlock>
        </DialogContent>
      </Dialog>
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
  ["fixed", "You cannot change this part of the page here."],
  [
    "crosses-script",
    "The selection includes content that you cannot change here. Select less text.",
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
  const { regions, scripts, edits } = data;
  return Array.isArray(regions) &&
    regions.every(isRegion) &&
    Array.isArray(scripts) &&
    scripts.every(isScriptChange) &&
    isOffset(edits)
    ? { regions, scripts, edits }
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
const isAnchor = (v: unknown): v is Anchor =>
  isObject(v) &&
  ["quote", "prefix", "suffix", "dom_path"].every((k) => typeof v[k] === "string") &&
  isOffset(v.start_offset) &&
  isOffset(v.end_offset);
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

// showHeading puts a heading of the document in the address, in place of
// the history entry, with no comment open.
function showHeading(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete("comment");
  url.hash = id;
  window.history.replaceState(window.history.state, "", url);
}
