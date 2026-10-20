import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { api, type CommentMention, type Principal } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { useCommentDrafts } from "@/lib/comment-drafts";
import { Center } from "@/components/ui/misc";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/lib/use-media-query";
import { useTheme } from "@/lib/theme";
import { useEscChord } from "@/lib/use-esc-chord";
import { createPersistentStore } from "@/lib/persistent-store";
import { cursorsShownStore } from "@/lib/live-cursors";
import { CHORD_WINDOW_MS, isChordBlocked, type ChordKey } from "@/lib/esc-chord";
import {
  COMMENT_STATUS,
  DEFAULT_COMMENT_FILTER,
  type CommentFilter,
} from "@/lib/constants";
import {
  DocProvider,
  type CommentPosition,
  type CommentViewport,
  type DocContextValue,
  type PendingSelection,
} from "./doc-context";
import { RenderFrame } from "./doc-render-frame";
import { Comments } from "./doc-comments";
import { Keycast } from "./doc-keycast";
import { ShortcutsDialog } from "./doc-shortcuts";

const THEME_LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

// The desktop comments panel stays as the reader left it, across documents
// and visits. The mobile sheet always starts closed.
const commentsOpenStore = createPersistentStore<boolean>(
  "slashdocs:comments-open",
  true,
  (parsed) => parsed !== false,
);

const pageStagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
};
const barSlide = {
  hidden: { opacity: 0, y: -8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.25, 0.4, 0.25, 1] as const },
  },
};
const contentFade = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.4, ease: [0.25, 0.4, 0.25, 1] as const },
  },
};

// A document without a live event stream, such as a `slashdocs local` file,
// has no KV events and no other viewers to tell.
const NO_STREAM = {
  subscribeKV: () => () => {},
  reportViewport: () => {},
  moveCursor: () => {},
  subscribeCursors: () => () => {},
};

export type DocBarControls = {
  commentsOpen: boolean;
  onToggleComments: () => void;
  onShowShortcuts: () => void;
};

// DocWorkspace is a rendered document with its comments: the comment rail,
// drafts, shortcuts, and full screen. The page around it supplies the
// document bar and the parts that only the server has, such as versions and
// sharing.
export function DocWorkspace({
  docId,
  version,
  principal,
  signIn,
  home,
  notifications = true,
  stream = NO_STREAM,
  followedCursor,
  onDocumentClick,
  bar,
}: {
  docId: string;
  version: string;
  principal?: Principal;
  signIn?: () => void;
  // The Esc H shortcut goes here.
  home: string;
  notifications?: boolean;
  stream?: {
    subscribeKV: DocContextValue["subscribeDocumentKV"];
    reportViewport: DocContextValue["reportViewport"];
    moveCursor: DocContextValue["moveCursor"];
    subscribeCursors: DocContextValue["subscribeCursors"];
  };
  followedCursor?: DocContextValue["followedCursor"];
  onDocumentClick?: () => void;
  bar: (controls: DocBarControls) => ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fullscreen = searchParams.get("fullscreen") === "1";
  // One comments query feeds both the paint overlay and the comment rail so they
  // stay in sync.
  const comments = useQuery({
    queryKey: queryKeys.comments(docId),
    queryFn: () => api.listComments(docId),
    enabled: !!docId,
    meta: { suppressGlobalError: true },
  });
  const [commentFilter, setCommentFilter] =
    useState<CommentFilter>(DEFAULT_COMMENT_FILTER);
  const [activeComment, setActiveComment] = useState<string>();
  const [canvasMode, setCanvasMode] = useState(false);
  const [pinLabels, setPinLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const [placingPin, setPlacingPin] = useState(false);
  const [unanchoredComments, setUnanchoredComments] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [commentPositions, setCommentPositions] = useState<
    ReadonlyMap<string, CommentPosition>
  >(new Map());
  const [commentViewport, setCommentViewport] = useState<CommentViewport>({
    scrollTop: 0,
    scrollHeight: 1,
  });
  const documentPrinterRef = useRef<(() => void) | null>(null);
  const registerDocumentPrinter = useCallback((print: (() => void) | null) => {
    documentPrinterRef.current = print;
  }, []);
  const printDocument = useCallback(() => {
    documentPrinterRef.current?.();
  }, []);
  const documentScrollerRef = useRef<((top: number) => void) | null>(null);
  const registerDocumentScroller = useCallback(
    (scroller: ((top: number) => void) | null) => {
      documentScrollerRef.current = scroller;
    },
    [],
  );
  const scrollDocumentTo = useCallback((top: number) => {
    documentScrollerRef.current?.(top);
  }, []);
  const pinRevealerRef = useRef<((id: string) => void) | null>(null);
  const registerPinRevealer = useCallback((reveal: ((id: string) => void) | null) => {
    pinRevealerRef.current = reveal;
  }, []);
  const revealPin = useCallback((id: string) => pinRevealerRef.current?.(id), []);
  const commentRailSyncRef = useRef<((top: number) => void) | null>(null);
  const registerCommentRailSync = useCallback(
    (sync: ((top: number) => void) | null) => {
      commentRailSyncRef.current = sync;
    },
    [],
  );
  const syncCommentRail = useCallback((top: number) => {
    commentRailSyncRef.current?.(top);
  }, []);
  const isMobile = useIsMobile();
  // A comment started while the comments are hidden shows them only until it
  // is posted or discarded.
  const [peekDraft, setPeekDraft] = useState<string>();
  const commentsOpen = commentsOpenStore.useStore() || peekDraft !== undefined;
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [showFullscreenHint, setShowFullscreenHint] = useState(false);
  const [chordLabel, setChordLabel] = useState<string>();
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();

  const handleDocCommentClick = useCallback(
    (commentId: string) => {
      setActiveComment(commentId);
      if (fullscreen) return;
      if (isMobile) setMobilePanelOpen(true);
      else commentsOpenStore.write(true);
    },
    [fullscreen, isMobile],
  );
  useEffect(() => {
    setCommentFilter(DEFAULT_COMMENT_FILTER);
    setPeekDraft(undefined);
  }, [docId]);

  const linkedComment = searchParams.get("comment");
  const handledCommentLink = useRef("");
  useEffect(() => {
    if (!linkedComment) {
      handledCommentLink.current = "";
      return;
    }
    if (!comments.data?.items) return;
    const key = `${docId}:${linkedComment}`;
    if (handledCommentLink.current === key) return;
    const root = comments.data.items.find(
      (c) => c.id === linkedComment || c.replies?.some((r) => r.id === linkedComment),
    );
    if (!root) return;
    handledCommentLink.current = key;
    setCommentFilter(
      root.status === COMMENT_STATUS.resolved
        ? COMMENT_STATUS.resolved
        : DEFAULT_COMMENT_FILTER,
    );
    handleDocCommentClick(root.id);
  }, [docId, linkedComment, comments.data, handleDocCommentClick]);

  const handleRenderedDocumentClick = useCallback(() => {
    onDocumentClick?.();
    setActiveComment(undefined);
  }, [onDocumentClick]);

  const toggleComments = useCallback(() => {
    if (isMobile) setMobilePanelOpen((o) => !o);
    else commentsOpenStore.write(!commentsOpen);
    setPeekDraft(undefined);
  }, [isMobile, commentsOpen]);

  // On mobile the comments sheet should be dismissable with the browser/OS
  // Back gesture, without leaving the document. We push a dedicated history
  // entry when it opens; Back pops that entry (closing the sheet) instead of
  // navigating away. Closing via the UI removes the entry we added.
  const sheetHistoryRef = useRef(false);
  useEffect(() => {
    if (!mobilePanelOpen) return;
    window.history.pushState({ slashdocsCommentsSheet: true }, "");
    sheetHistoryRef.current = true;
    const onPop = () => {
      sheetHistoryRef.current = false;
      setMobilePanelOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // If the sheet closed via the UI (not via Back), remove the entry we
      // pushed so the next Back returns to the documents list as expected.
      if (sheetHistoryRef.current) {
        sheetHistoryRef.current = false;
        window.history.back();
      }
    };
  }, [mobilePanelOpen]);

  // Radix Dialog's scroll-lock (react-remove-scroll) can leave the body
  // with `overflow: hidden` / `pointer-events: none` after the mobile
  // comments sheet closes, which freezes document scrolling. Restore the
  // body once the sheet is fully closed. (`modal={false}` on the Sheet
  // would avoid the lock, but Radix then skips the overlay and outside
  // dismissal entirely, so we keep modal behavior and clean up after it.)
  useEffect(() => {
    if (mobilePanelOpen) return;
    const restore = () => {
      for (const el of [document.body, document.documentElement]) {
        el.style.removeProperty("overflow");
        el.style.removeProperty("padding-right");
        el.style.removeProperty("pointer-events");
        el.removeAttribute("data-scroll-locked");
      }
    };
    // Run after Radix's own close cleanup on the next frame.
    const id = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(id);
  }, [mobilePanelOpen]);

  useEffect(() => {
    setCommentPositions(new Map());
    setCommentViewport({ scrollTop: 0, scrollHeight: 1 });
  }, [version]);

  const [drafts, updateDrafts] = useCommentDrafts(docId);
  // Drafts left empty on an earlier visit hold nothing worth keeping.
  useEffect(() => {
    updateDrafts((list) => list.filter((draft) => draft.body.trim()));
  }, [updateDrafts]);

  // A selection starts a new draft next to the drafts that have text. Picking
  // the same text again returns to its draft.
  const startDraft = useCallback(
    (selection: PendingSelection) => {
      if (signIn) return signIn();
      let draftId = `draft:${crypto.randomUUID()}`;
      updateDrafts((list) => {
        // A pin draft is the same spot on the same target; a text draft is
        // the same quote at the same offset.
        const point = selection.anchor?.point;
        const near = (a?: number, b?: number) =>
          a !== undefined && b !== undefined && Math.abs(a - b) < 0.001;
        const same = list.find((draft) =>
          draft.version !== version
            ? false
            : point
              ? draft.anchor?.point?.target === point.target &&
                near(draft.anchor.point.x, point.x) &&
                near(draft.anchor.point.y, point.y)
              : !draft.anchor?.point &&
                draft.quote === selection.quote &&
                draft.anchor?.start_offset === selection.anchor?.start_offset,
        );
        if (same) {
          draftId = same.id;
          return list;
        }
        const draft = {
          id: draftId,
          version,
          ...selection,
          body: "",
          mentions: [],
          updatedAt: Date.now(),
        };
        return [...list.filter((d) => d.body.trim()), draft];
      });
      setCommentFilter(COMMENT_STATUS.open);
      setActiveComment(draftId);
      if (fullscreen) return;
      // The newest draft keeps a peek, so the panel stays while it is written.
      if (peekDraft !== undefined || !(isMobile ? mobilePanelOpen : commentsOpen)) {
        setPeekDraft(draftId);
      }
      if (isMobile) setMobilePanelOpen(true);
    },
    [
      version,
      updateDrafts,
      signIn,
      fullscreen,
      isMobile,
      mobilePanelOpen,
      commentsOpen,
      peekDraft,
    ],
  );
  const saveDraft = useCallback(
    (draftId: string, text: { body: string; mentions: CommentMention[] }) =>
      updateDrafts((list) =>
        list.map((d) =>
          d.id === draftId ? { ...d, ...text, updatedAt: Date.now() } : d,
        ),
      ),
    [updateDrafts],
  );
  const discardDraft = useCallback(
    (draftId: string) => {
      updateDrafts((list) => list.filter((d) => d.id !== draftId));
      if (draftId !== peekDraft) return;
      setPeekDraft(undefined);
      setMobilePanelOpen(false);
    },
    [updateDrafts, peekDraft],
  );

  const exitFullscreen = useCallback(() => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("fullscreen");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const toggleFullscreen = useCallback(() => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (next.get("fullscreen") === "1") next.delete("fullscreen");
        else next.set("fullscreen", "1");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  useEffect(() => {
    if (!fullscreen) return;
    setShowFullscreenHint(true);
    const timeout = window.setTimeout(() => setShowFullscreenHint(false), 4000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [fullscreen]);

  const cursorsShown = cursorsShownStore.useStore();
  const chordKeys = useMemo<ChordKey[]>(
    () => (fullscreen ? ["t", "f", "m", "h"] : ["t", "f", "c", "m", "h"]),
    [fullscreen],
  );
  const runChord = useCallback(
    (key: ChordKey) => {
      if (key === "t") {
        const nextTheme =
          theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
        setTheme(nextTheme);
        setChordLabel(THEME_LABELS[nextTheme]);
        return;
      }
      if (key === "f") {
        setChordLabel(fullscreen ? "Exited full screen" : "Full screen");
        toggleFullscreen();
        return;
      }
      if (key === "c") {
        setChordLabel(
          (isMobile ? mobilePanelOpen : commentsOpen)
            ? "Comments hidden"
            : "Comments shown",
        );
        toggleComments();
        return;
      }
      if (key === "m") {
        setChordLabel(cursorsShown ? "Cursors hidden" : "Cursors shown");
        cursorsShownStore.write(!cursorsShown);
        return;
      }
      setChordLabel("Documents");
      nav(home);
    },
    [
      theme,
      setTheme,
      fullscreen,
      toggleFullscreen,
      isMobile,
      mobilePanelOpen,
      commentsOpen,
      toggleComments,
      cursorsShown,
      nav,
      home,
    ],
  );
  // ? shows every shortcut, as in GitHub and Gmail. The bridge forwards it
  // from the document.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "?" && !isChordBlocked(event.target)) setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // The Esc that stops placing a pin only does that: it must not also close
  // the thread a moment later, when the Esc chord gives up.
  const placingEndedAt = useRef(0);
  useEffect(() => {
    if (!placingPin) placingEndedAt.current = Date.now();
  }, [placingPin]);
  const onBareEscape = useCallback(() => {
    if (fullscreen) exitFullscreen();
    else if (Date.now() - placingEndedAt.current > CHORD_WINDOW_MS + 200)
      setActiveComment(undefined);
  }, [fullscreen, exitFullscreen]);
  const chord = useEscChord({
    available: chordKeys,
    onRun: runChord,
    onEscape: onBareEscape,
  });

  const ctx = useMemo(
    () => ({
      docId,
      version,
      comments: comments.data?.items || [],
      commentFilter,
      setCommentFilter,
      commentsLoading: comments.isLoading,
      commentsError: !!comments.error,
      notifications,
      principal,
      signIn,
      drafts,
      startDraft,
      saveDraft,
      discardDraft,
      activeComment,
      setActiveComment,
      unanchoredComments,
      setUnanchoredComments,
      commentPositions,
      setCommentPositions,
      commentViewport,
      setCommentViewport,
      registerDocumentPrinter,
      printDocument,
      registerDocumentScroller,
      scrollDocumentTo,
      registerCommentRailSync,
      syncCommentRail,
      handleDocCommentClick,
      handleRenderedDocumentClick,
      subscribeDocumentKV: stream.subscribeKV,
      reportViewport: stream.reportViewport,
      moveCursor: stream.moveCursor,
      subscribeCursors: stream.subscribeCursors,
      followedCursor,
      canvasMode,
      setCanvasMode,
      placingPin,
      setPlacingPin,
      registerPinRevealer,
      revealPin,
      pinLabels,
      setPinLabels,
      pinsShown: isMobile || commentsOpen,
    }),
    [
      docId,
      version,
      comments.data,
      commentFilter,
      comments.isLoading,
      comments.error,
      notifications,
      principal,
      signIn,
      drafts,
      startDraft,
      saveDraft,
      discardDraft,
      activeComment,
      unanchoredComments,
      commentPositions,
      commentViewport,
      setActiveComment,
      registerDocumentPrinter,
      printDocument,
      registerDocumentScroller,
      scrollDocumentTo,
      registerCommentRailSync,
      syncCommentRail,
      handleDocCommentClick,
      handleRenderedDocumentClick,
      stream.subscribeKV,
      stream.reportViewport,
      stream.moveCursor,
      stream.subscribeCursors,
      followedCursor,
      canvasMode,
      placingPin,
      registerPinRevealer,
      revealPin,
      pinLabels,
      isMobile,
      commentsOpen,
    ],
  );

  const frame = (
    <>
      {version ? <RenderFrame /> : <Center>No version available.</Center>}
      <Keycast state={chord} available={chordKeys} label={chordLabel} />
    </>
  );
  return (
    <DocProvider value={ctx}>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {fullscreen ? (
        <div className="relative h-full bg-[var(--color-surface-muted)]">
          {showFullscreenHint ? (
            <div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-full bg-[var(--color-surface)] px-6 py-3 text-base font-semibold text-[var(--color-fg)] shadow-xl ring-1 ring-[var(--color-border)]">
              <span className="hidden sm:inline">
                Esc to exit · ? for all shortcuts
              </span>
              <span className="sm:hidden">Go back to exit full screen</span>
            </div>
          ) : null}
          {frame}
        </div>
      ) : (
        <motion.div
          className="flex h-full flex-col"
          initial="hidden"
          animate="visible"
          variants={pageStagger}
        >
          <motion.div variants={barSlide}>
            {bar({
              commentsOpen: isMobile ? mobilePanelOpen : commentsOpen,
              onToggleComments: toggleComments,
              onShowShortcuts: () => setShortcutsOpen(true),
            })}
          </motion.div>
          <motion.div variants={contentFade} className="flex flex-1 overflow-hidden">
            <section className="relative min-w-0 flex-1 bg-[var(--color-surface-muted)]">
              {frame}
            </section>
            <AnimatePresence initial={false}>
              {commentsOpen && !isMobile && (
                <motion.aside
                  key="comment-rail"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 360, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ type: "spring", duration: 0.35, bounce: 0 }}
                  className="relative hidden shrink-0 overflow-hidden bg-[var(--color-chrome)] md:block"
                >
                  <div className="h-full w-[360px]">
                    <Comments />
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Mobile: comments live in a slide-over sheet */}
          <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
            <SheetContent
              side="right"
              className="w-full max-w-md p-0 md:hidden"
              aria-describedby={undefined}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Comments</SheetTitle>
              </SheetHeader>
              <Comments mobile />
            </SheetContent>
          </Sheet>
        </motion.div>
      )}
    </DocProvider>
  );
}
