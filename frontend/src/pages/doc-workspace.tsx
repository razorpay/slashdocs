import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Principal } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { signInPath } from "@/lib/auth-state";
import {
  keepPendingComment,
  takePendingComment,
  useCommentDrafts,
  type DraftText,
} from "@/lib/comment-drafts";
import { Button } from "@/components/ui/button";
import type { ThreadCount } from "@/components/layout/doc-bar-frame";
import { Center } from "@/components/ui/misc";
import { SheetHandle } from "@/components/ui/sheet";
import { keepToastsAbove } from "@/components/ui/toaster";
import { useIsMobile } from "@/lib/use-media-query";
import { useTheme } from "@/lib/theme";
import { useEscChord } from "@/lib/use-esc-chord";
import { cursorsShownStore } from "@/lib/live-cursors";
import { isChordBlocked, type ChordKey } from "@/lib/esc-chord";
import { randomId } from "@/lib/uuid";
import { cn } from "@/lib/cn";
import { fade, sheetUp, slideIn } from "@/lib/motion";
import { COMMENT_STATUS } from "@/lib/constants";
import {
  DocProvider,
  notSaved,
  type CommentPosition,
  type DocContextValue,
  type PendingSelection,
  type SaveState,
  type UnanchoredKind,
} from "./doc-context";
import { RenderFrame } from "./doc-render-frame";
import { CommentsList } from "./doc-comments";
import { CommentMap } from "./comment-map";
import { Keycast } from "./doc-keycast";
import { ShortcutsDialog } from "./doc-shortcuts";
import { useCommentLink } from "./use-comment-link";
import { useCommentReads } from "./use-comment-reads";
import { plainKey } from "./use-comment-pins";

const THEME_LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

// A document without a live event stream, such as a `slashdocs local` file,
// has no KV events and no other viewers to tell.
const NO_STREAM = {
  subscribeKV: () => () => {},
  reportViewport: () => {},
  moveCursor: () => {},
  subscribeCursors: () => () => {},
};

const noop = () => {};

// The document's area. A narrow screen keeps a gutter for the tick strip,
// off the text, in the paper white of the document, and the same gutter on
// the left, so that a document with no margin of its own does not touch the
// edge.
const FRAME_AREA = "relative h-full max-sm:bg-white max-sm:px-3";
// The comments list and its gap at the right of the document.
const PANEL_ROOM = 392;

// The intents in the sign-in path of a reader who asked to comment on a spot,
// or on the text that they selected.
const PIN_INTENT = "pin";
const COMMENT_INTENT = "comment";

export type DocBarControls = {
  // The comments list is open.
  commentsOpen: boolean;
  threads: ThreadCount;
  onToggleComments: () => void;
  onShowShortcuts: () => void;
};

// DocWorkspace is a rendered document with its comments: their popovers, the
// comments list, drafts, shortcuts, and full screen. The page around it
// supplies the document bar, an optional banner, and the parts that only the
// server has, such as versions and sharing.
export function DocWorkspace({
  docId,
  version,
  principal,
  signIn,
  home,
  notifications = true,
  stream = NO_STREAM,
  followedCursor,
  onUnfollowCursor,
  onDocumentClick,
  canEdit = false,
  editing = false,
  onEditingChange = noop,
  stayOnVersion = noop,
  showLatest = noop,
  showsLatest = true,
  bar,
  banner,
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
  onUnfollowCursor?: DocContextValue["onUnfollowCursor"];
  onDocumentClick?: () => void;
  // The reader may edit the version on screen.
  canEdit?: boolean;
  // Edit mode, which the page keeps. Each document opens in Comment mode.
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  stayOnVersion?: (version?: string) => void;
  showLatest?: () => void;
  // The version on screen is the document's latest one.
  showsLatest?: boolean;
  bar: (controls: DocBarControls) => ReactNode;
  // Shown under the bar, or floating over the document in full screen.
  banner?: (floating: boolean) => ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fullscreen = searchParams.get("fullscreen") === "1";
  // One comments query feeds the highlights, the pins and the popovers, so
  // they stay in sync.
  const comments = useQuery({
    queryKey: queryKeys.comments(docId),
    queryFn: () => api.listComments(docId),
    enabled: !!docId,
    meta: { suppressGlobalError: true },
  });
  const [activeComment, setActiveComment] = useState<string>();
  const { comments: readComments, readThread } = useCommentReads(
    docId,
    comments,
    activeComment,
  );
  const [placingPin, setPlacingPin] = useState<boolean | string>(false);
  const [unanchored, setUnanchored] = useState<
    Record<UnanchoredKind, ReadonlySet<string>>
  >({ text: new Set(), pins: new Set() });
  const setUnanchoredComments = useCallback(
    (kind: UnanchoredKind, ids: ReadonlySet<string>) =>
      setUnanchored((current) => ({ ...current, [kind]: ids })),
    [],
  );
  const unanchoredComments = useMemo(
    () => new Set([...unanchored.text, ...unanchored.pins]),
    [unanchored],
  );
  const [movedPins, setMovedPins] = useState<ReadonlySet<string>>(new Set());
  const [commentPositions, setCommentPositions] = useState<
    ReadonlyMap<string, CommentPosition>
  >(new Map());
  const [documentHeight, setDocumentHeight] = useState(1);
  const documentPrinterRef = useRef<(() => void) | null>(null);
  const registerDocumentPrinter = useCallback((print: (() => void) | null) => {
    documentPrinterRef.current = print;
  }, []);
  const printDocument = useCallback(() => {
    documentPrinterRef.current?.();
  }, []);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [frameReady, setFrameReady] = useState(false);
  const textSettle = useRef<(() => Promise<boolean>) | null>(null);
  const registerTextSettle = useCallback((settle: (() => Promise<boolean>) | null) => {
    textSettle.current = settle;
  }, []);
  const setEditing = useCallback(
    async (on: boolean) => {
      if (on ? !canEdit : (await textSettle.current?.()) === false) return;
      onEditingChange(on);
    },
    [canEdit, onEditingChange],
  );
  const retrySave = useCallback(() => void textSettle.current?.(), []);
  useEffect(() => setSaveState("idle"), [docId]);
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
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  // The comments list covers the document's right margin, and the document
  // glides left from under it when it can. When its margins are too narrow
  // for that, it is crowded: the list takes room beside it.
  const [crowded, setCrowded] = useState(false);
  useEffect(() => {
    if (!listOpen) setCrowded(false);
  }, [listOpen]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [showFullscreenHint, setShowFullscreenHint] = useState(false);
  const [chordLabel, setChordLabel] = useState<string>();
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setActiveComment(undefined);
    setListOpen(false);
    setPlacingPin(false);
  }, [docId]);

  const [jump, setJump] = useState<{ id: string }>();
  const jumpToComment = useCallback((id: string) => {
    setActiveComment(id);
    setJump({ id });
  }, []);
  useCommentLink(docId, comments, jumpToComment);

  const handleRenderedDocumentClick = useCallback(() => {
    onDocumentClick?.();
    setActiveComment(undefined);
    setListOpen(false);
  }, [onDocumentClick]);

  const toggleComments = useCallback(() => setListOpen((open) => !open), []);
  // The list takes the focus when it opens, and gives it back when it
  // closes, unless the reader moved it on, as into the document.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!listOpen || !list) return;
    const opener = document.activeElement;
    list.focus({ preventScroll: true });
    return () => {
      const focus = document.activeElement;
      const lost = focus === document.body || list.contains(focus);
      if (lost && opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, [listOpen]);
  useEffect(
    () => (listOpen ? keepToastsAbove(listRef.current) : undefined),
    [listOpen],
  );
  const pickComment = useCallback(
    (id: string) => {
      setListOpen(false);
      jumpToComment(id);
    },
    [jumpToComment],
  );
  // A reader who is signed out signs in first, and comes back to place it.
  const location = useLocation();
  const placePin = useCallback(() => {
    setListOpen(false);
    if (signIn) nav(signInPath(location, PIN_INTENT));
    else setPlacingPin(true);
  }, [signIn, nav, location]);

  const [drafts, updateDrafts] = useCommentDrafts(docId);
  // Drafts left empty on an earlier visit hold nothing worth keeping.
  useEffect(() => {
    updateDrafts((list) => list.filter((draft) => draft.body.trim()));
  }, [updateDrafts]);
  // A draft left empty goes when its popover closes, as in Figma.
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;
  const previousActive = useRef(activeComment);
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = activeComment;
    if (!previous || previous === activeComment) return;
    // Later than the composer's save, which holds what was typed last.
    window.setTimeout(() => {
      const empty = latestDrafts.current.some(
        (d) => d.id === previous && !d.body.trim(),
      );
      if (empty && previousActive.current !== previous)
        updateDrafts((list) => list.filter((d) => d.id !== previous));
    }, 500);
  }, [activeComment, updateDrafts]);

  // A selection or a placed pin starts a new draft next to the drafts that
  // have text. Picking the same text or spot again returns to its draft. A
  // reader who is signed out signs in first, and comes back to the draft.
  const startDraft = useCallback(
    (selection: PendingSelection, draftVersion = version) => {
      if (signIn) {
        keepPendingComment({ docId, version: draftVersion, selection });
        return nav(signInPath(location, COMMENT_INTENT));
      }
      let draftId = `draft:${randomId()}`;
      updateDrafts((list) => {
        const key = (anchor?: PendingSelection["anchor"]) =>
          JSON.stringify([anchor?.point, anchor?.start_offset]);
        const same = list.find(
          (draft) =>
            draft.version === draftVersion &&
            draft.quote === selection.quote &&
            key(draft.anchor) === key(selection.anchor),
        );
        if (same) {
          draftId = same.id;
          return list;
        }
        const draft = {
          id: draftId,
          version: draftVersion,
          ...selection,
          body: selection.body ?? "",
          mentions: [],
          updatedAt: Date.now(),
        };
        return [...list.filter((d) => d.body.trim()), draft];
      });
      setActiveComment(draftId);
    },
    [docId, version, updateDrafts, signIn, nav, location],
  );
  // Back from sign-in, the reader goes on with what they asked for.
  const intent = searchParams.get("intent");
  useEffect(() => {
    if (!intent || !principal) return;
    if (intent === PIN_INTENT) setPlacingPin(true);
    const pending = intent === COMMENT_INTENT && takePendingComment(docId);
    if (pending) startDraft(pending.selection, pending.version);
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("intent");
        return next;
      },
      { replace: true },
    );
  }, [intent, principal, docId, startDraft, setSearchParams]);
  const saveDraft = useCallback(
    (draftId: string, text: DraftText) =>
      updateDrafts((list) =>
        list.map((d) =>
          d.id === draftId ? { ...d, ...text, updatedAt: Date.now() } : d,
        ),
      ),
    [updateDrafts],
  );
  const moveDraft = useCallback<DocContextValue["moveDraft"]>(
    (draftId, anchor) =>
      updateDrafts((list) =>
        list.map((d) =>
          d.id === draftId
            ? { ...d, quote: anchor.quote ?? "", anchor, updatedAt: Date.now() }
            : d,
        ),
      ),
    [updateDrafts],
  );
  const discardDraft = useCallback(
    (draftId: string) => {
      updateDrafts((list) => list.filter((d) => d.id !== draftId));
      setActiveComment((active) => (active === draftId ? undefined : active));
    },
    [updateDrafts],
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
        setChordLabel(listOpen ? "Comments hidden" : "Comments");
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
      listOpen,
      toggleComments,
      cursorsShown,
      nav,
      home,
    ],
  );
  // ? shows every shortcut, as in GitHub and Gmail, and E starts Edit mode.
  // The bridge forwards them from the document.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "?" && !isChordBlocked(event.target)) setShortcutsOpen(true);
      if (canEdit && !editing && plainKey(event, "e")) {
        event.preventDefault();
        void setEditing(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEdit, editing, setEditing]);
  const onBareEscape = useCallback(() => {
    if (fullscreen) exitFullscreen();
    else if (listOpen) setListOpen(false);
    else setActiveComment(undefined);
  }, [fullscreen, exitFullscreen, listOpen]);
  // An Esc from anywhere stops placing a pin, or closes the open thread, or
  // leaves Edit mode, also with the caret in the text.
  const takeEscape = useCallback(() => {
    if (placingPin) setPlacingPin(false);
    else if (activeComment) setActiveComment(undefined);
    else if (editing) void setEditing(false);
    else return false;
    return true;
  }, [placingPin, activeComment, editing, setEditing]);
  const chord = useEscChord({
    available: chordKeys,
    onRun: runChord,
    onEscape: onBareEscape,
    takeEscape,
  });

  const ctx = useMemo(
    () => ({
      docId,
      version,
      comments: readComments,
      commentsLoading: comments.isLoading,
      commentsError: !!comments.error,
      notifications,
      principal,
      signIn,
      drafts,
      startDraft,
      saveDraft,
      moveDraft,
      discardDraft,
      activeComment,
      setActiveComment,
      jumpToComment,
      jump,
      readThread,
      unanchoredComments,
      setUnanchoredComments,
      movedPins,
      setMovedPins,
      commentPositions,
      setCommentPositions,
      documentHeight,
      setDocumentHeight,
      registerDocumentPrinter,
      printDocument,
      registerDocumentScroller,
      scrollDocumentTo,
      handleDocCommentClick: setActiveComment,
      handleRenderedDocumentClick,
      placingPin,
      setPlacingPin,
      subscribeDocumentKV: stream.subscribeKV,
      reportViewport: stream.reportViewport,
      moveCursor: stream.moveCursor,
      subscribeCursors: stream.subscribeCursors,
      followedCursor,
      onUnfollowCursor,
      canEdit,
      editing,
      setEditing,
      registerTextSettle,
      saveState,
      setSaveState,
      retrySave,
      frameReady,
      setFrameReady,
      stayOnVersion,
      showLatest,
    }),
    [
      docId,
      version,
      readComments,
      comments.isLoading,
      comments.error,
      notifications,
      principal,
      signIn,
      drafts,
      startDraft,
      saveDraft,
      moveDraft,
      discardDraft,
      activeComment,
      jumpToComment,
      jump,
      readThread,
      unanchoredComments,
      setUnanchoredComments,
      movedPins,
      commentPositions,
      documentHeight,
      registerDocumentPrinter,
      printDocument,
      registerDocumentScroller,
      scrollDocumentTo,
      handleRenderedDocumentClick,
      placingPin,
      stream.subscribeKV,
      stream.reportViewport,
      stream.moveCursor,
      stream.subscribeCursors,
      followedCursor,
      onUnfollowCursor,
      canEdit,
      editing,
      setEditing,
      registerTextSettle,
      saveState,
      retrySave,
      frameReady,
      stayOnVersion,
      showLatest,
    ],
  );

  const threads = useMemo(() => {
    const open = ctx.comments.filter((c) => c.status === COMMENT_STATUS.open);
    return { open: open.length, unread: open.some((c) => c.unread) };
  }, [ctx.comments]);
  // The tick strip marks the threads that the document highlights or pins.
  const shownComments = useMemo(
    () =>
      ctx.comments.filter(
        (c) => c.status !== COMMENT_STATUS.resolved || c.id === activeComment,
      ),
    [ctx.comments, activeComment],
  );
  const frame = (
    <>
      {version ? (
        <RenderFrame
          chordArmed={chord.phase === "armed"}
          cover={listOpen && !isMobile && !crowded ? PANEL_ROOM : 0}
          onCrowded={() => setCrowded(true)}
        />
      ) : (
        <Center>Nothing to show yet.</Center>
      )}
      <CommentMap comments={shownComments} />
      <Keycast state={chord} available={chordKeys} label={chordLabel} />
      {/* In Edit mode an accent edge runs along the top of the document, red
          while the edits do not save. It grows from the left and shrinks
          back, by its transform alone. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 origin-left bg-[var(--color-accent)] transition-[scale,background-color] duration-200 ease-out motion-reduce:transition-none",
          !editing && "scale-x-0 duration-150",
          notSaved(saveState) && "bg-[var(--color-danger)]",
        )}
      />
    </>
  );
  return (
    <DocProvider value={ctx}>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {fullscreen ? (
        <div className={cn("bg-[var(--color-surface-muted)]", FRAME_AREA)}>
          {showFullscreenHint ? (
            <div className="pointer-events-none absolute left-1/2 top-6 z-20 hidden -translate-x-1/2 rounded-full bg-[var(--color-surface)] px-6 py-3 text-base font-semibold text-[var(--color-fg)] shadow-xl ring-1 ring-[var(--color-border)] sm:block">
              Esc to exit · ? for all shortcuts
            </div>
          ) : null}
          {/* A phone has no Esc key, so its exit stays in view. */}
          <Button
            variant="outline"
            size="icon"
            onClick={exitFullscreen}
            aria-label="Exit full screen"
            className="absolute right-4 top-3 z-20 h-10 w-10 rounded-full sm:hidden"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
          {frame}
          {banner?.(true)}
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {bar({
            commentsOpen: listOpen,
            threads,
            onToggleComments: toggleComments,
            onShowShortcuts: () => setShortcutsOpen(true),
          })}
          {banner?.(false)}
          <section className="relative min-w-0 flex-1 overflow-hidden bg-[var(--color-surface-muted)]">
            {/* A wide screen makes room for the list beside a crowded
                document, as Google Docs does. The room opens at once, so the
                text reflows one time, and only the list slides in. Under the
                sheet of a narrow one, the document is out of reach. */}
            <div
              inert={listOpen && isMobile}
              className={cn(FRAME_AREA, crowded && "lg:mr-[392px]")}
            >
              {frame}
            </div>
            <AnimatePresence>
              {listOpen && isMobile ? (
                <motion.div
                  key="backdrop"
                  {...fade}
                  aria-hidden="true"
                  onClick={() => setListOpen(false)}
                  className="absolute inset-0 z-30 bg-[hsl(218_30%_12%/0.24)] dark:bg-black/60"
                />
              ) : null}
              {listOpen ? (
                // The comment history, as in Google Docs: under the bar on the
                // right, or a sheet at the bottom of a narrow screen.
                <motion.div
                  key="comments"
                  ref={listRef}
                  tabIndex={-1}
                  {...(isMobile ? sheetUp : slideIn)}
                  role="dialog"
                  aria-label="Comments"
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.stopPropagation();
                    setListOpen(false);
                  }}
                  className={cn(
                    "absolute z-30 flex flex-col overflow-hidden bg-[var(--color-surface)] shadow-xl ring-1 ring-[var(--color-border)] outline-none",
                    isMobile
                      ? "inset-x-0 bottom-0 max-h-[70%] rounded-t-2xl"
                      : "right-4 top-3 max-h-[calc(100%-1.5rem)] w-[360px] rounded-xl",
                  )}
                >
                  {isMobile && <SheetHandle />}
                  <CommentsList
                    showsLatest={showsLatest}
                    onPick={pickComment}
                    onPlacePin={placePin}
                    retry={comments}
                    onClose={() => setListOpen(false)}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>
        </div>
      )}
    </DocProvider>
  );
}
