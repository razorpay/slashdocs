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
import { api, type CommentMention, type Principal } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { signInPath } from "@/lib/auth-state";
import { useCommentDrafts } from "@/lib/comment-drafts";
import { Button } from "@/components/ui/button";
import { Center } from "@/components/ui/misc";
import { SheetHandle } from "@/components/ui/sheet";
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

// The intent in the sign-in path of a reader who asked to comment on a spot.
const PIN_INTENT = "pin";

export type DocBarControls = {
  // The comments list is open.
  commentsOpen: boolean;
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
  editable = false,
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
  editable?: boolean;
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
  const [placingPin, setPlacingPin] = useState(false);
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
  useEffect(() => {
    setSaveState("idle");
  }, [docId]);
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

  useCommentLink(docId, comments, setActiveComment);

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
  const pickComment = useCallback((id: string) => {
    setListOpen(false);
    setActiveComment(id);
  }, []);
  // A reader who is signed out signs in first, and comes back to place it.
  const location = useLocation();
  const placePin = useCallback(() => {
    setListOpen(false);
    if (signIn) nav(signInPath(location, PIN_INTENT));
    else setPlacingPin(true);
  }, [signIn, nav, location]);
  const intent = searchParams.get("intent");
  useEffect(() => {
    if (intent !== PIN_INTENT || !principal) return;
    setPlacingPin(true);
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("intent");
        return next;
      },
      { replace: true },
    );
  }, [intent, principal, setSearchParams]);

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
  // have text. Picking the same text or spot again returns to its draft.
  const startDraft = useCallback(
    (selection: PendingSelection) => {
      if (signIn) return signIn();
      let draftId = `draft:${randomId()}`;
      updateDrafts((list) => {
        const key = (anchor?: PendingSelection["anchor"]) =>
          JSON.stringify([anchor?.point, anchor?.start_offset]);
        const same = list.find(
          (draft) =>
            draft.version === version &&
            draft.quote === selection.quote &&
            key(draft.anchor) === key(selection.anchor),
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
      setActiveComment(draftId);
    },
    [version, updateDrafts, signIn],
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
  // ? shows every shortcut, as in GitHub and Gmail. The bridge forwards it
  // from the document.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "?" && !isChordBlocked(event.target)) setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const onBareEscape = useCallback(() => {
    if (fullscreen) exitFullscreen();
    else if (listOpen) setListOpen(false);
    else setActiveComment(undefined);
  }, [fullscreen, exitFullscreen, listOpen]);
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
      unanchoredComments,
      setUnanchoredComments,
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
      editable,
      saveState,
      setSaveState,
      stayOnVersion,
      showLatest,
    }),
    [
      docId,
      version,
      comments.data,
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
      unanchoredComments,
      setUnanchoredComments,
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
      editable,
      saveState,
      stayOnVersion,
      showLatest,
    ],
  );

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
      {version ? <RenderFrame /> : <Center>Nothing to show yet.</Center>}
      <CommentMap comments={shownComments} />
      <Keycast state={chord} available={chordKeys} label={chordLabel} />
    </>
  );
  return (
    <DocProvider value={ctx}>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {fullscreen ? (
        <div className="relative h-full bg-[var(--color-surface-muted)] max-sm:pr-3">
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
            onToggleComments: toggleComments,
            onShowShortcuts: () => setShortcutsOpen(true),
          })}
          {banner?.(false)}
          <section className="relative min-w-0 flex-1 overflow-hidden bg-[var(--color-surface-muted)]">
            {/* A wide screen makes room for the list beside the document, as
                Google Docs does. The room opens at once, so the text reflows
                one time, and only the list slides in. Under the sheet of a
                narrow one, the document is out of reach. A narrow screen
                keeps a gutter for the tick strip, off the text. */}
            <div
              inert={listOpen && isMobile}
              className={cn("relative h-full max-sm:pr-3", listOpen && "lg:mr-[392px]")}
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
                    onRetry={comments.refetch}
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
