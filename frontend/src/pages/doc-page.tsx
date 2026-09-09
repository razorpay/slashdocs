import { useTitle } from "@/lib/use-title";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, KeyRound, Send } from "lucide-react";
import { api, APIError, currentVersionID, docTitle, versionID } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { Center, Skeleton } from "@/components/ui/misc";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/lib/use-media-query";
import { useTheme } from "@/lib/theme";
import { useEscChord } from "@/lib/use-esc-chord";
import type { ChordKey } from "@/lib/esc-chord";
import {
  DocProvider,
  type CommentPosition,
  type CommentViewport,
  type PendingSelection,
} from "./doc-context";
import { DocBar } from "./doc-bar";
import { RenderFrame } from "./doc-render-frame";
import { Comments } from "./doc-comments";
import {
  COMMENT_STATUS,
  DEFAULT_COMMENT_FILTER,
  type CommentFilter,
} from "@/lib/constants";
import { Keycast } from "./doc-keycast";
import { Button } from "@/components/ui/button";

const THEME_LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

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

function DocumentErrorState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Center>
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{description}</p>
        {children}
      </div>
    </Center>
  );
}

function AccessDeniedState({ documentID }: { documentID: string }) {
  const requestAccess = useMutation({
    mutationFn: () => api.requestDocumentAccess(documentID),
  });
  const sent = requestAccess.isSuccess;
  return (
    <DocumentErrorState
      title="You don't have access to this document"
      description={
        sent
          ? "The owner has been notified."
          : "Send the owner a request to grant you access."
      }
    >
      <div className="mt-5 flex flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
          <KeyRound aria-hidden="true" className="h-5 w-5" />
        </div>
        <Button
          className="mt-1"
          disabled={requestAccess.isPending || sent}
          onClick={() => requestAccess.mutate()}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={sent ? "sent" : requestAccess.isPending ? "sending" : "request"}
              className="inline-flex items-center gap-2"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            >
              {sent ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              {sent
                ? "Request sent"
                : requestAccess.isPending
                  ? "Sending…"
                  : "Request access"}
            </motion.span>
          </AnimatePresence>
        </Button>
        {requestAccess.isError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            Could not send the request. Please try again.
          </p>
        ) : null}
      </div>
    </DocumentErrorState>
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const fullscreen = searchParams.get("fullscreen") === "1";
  const queryVersion = searchParams.get("version") || undefined;
  const doc = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    meta: { suppressGlobalError: true },
  });
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const versions = useQuery({
    queryKey: queryKeys.versions(id),
    queryFn: () => api.listVersions(id),
    enabled: !!id && !doc.error,
    meta: { suppressGlobalError: true },
  });
  // One comments query feeds both the paint overlay and the comment rail so they
  // stay in sync.
  const comments = useQuery({
    queryKey: queryKeys.comments(id),
    queryFn: () => api.listComments(id),
    enabled: !!id && !doc.error,
    meta: { suppressGlobalError: true },
  });
  const [commentFilter, setCommentFilter] =
    useState<CommentFilter>(DEFAULT_COMMENT_FILTER);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [activeComment, setActiveComment] = useState<string>();
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
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const isMobile = useIsMobile();
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [shareOpen, setShareOpen] = useState(searchParams.get("share") === "1");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [showFullscreenHint, setShowFullscreenHint] = useState(false);
  const [chordLabel, setChordLabel] = useState<string>();
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();
  useTitle(doc.data ? docTitle(doc.data) : undefined);

  const handleDocCommentClick = useCallback(
    (commentId: string) => {
      setActiveComment(commentId);
      if (fullscreen) return;
      if (isMobile) setMobilePanelOpen(true);
      else setCommentsOpen(true);
    },
    [fullscreen, isMobile],
  );
  useEffect(() => {
    setCommentFilter(DEFAULT_COMMENT_FILTER);
  }, [id]);

  const linkedComment = searchParams.get("comment");
  const handledCommentLink = useRef("");
  useEffect(() => {
    if (!linkedComment) {
      handledCommentLink.current = "";
      return;
    }
    if (!comments.data?.items) return;
    const key = `${id}:${linkedComment}`;
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
  }, [id, linkedComment, comments.data, handleDocCommentClick]);

  const handleRenderedDocumentClick = useCallback(() => {
    setShareOpen(false);
    setActiveComment(undefined);
  }, []);

  // A text selection from the rendered doc should reveal the compose flow.
  useEffect(() => {
    if (fullscreen || !selection?.quote) return;
    if (isMobile) setMobilePanelOpen(true);
    else setCommentsOpen(true);
  }, [isMobile, fullscreen, selection]);

  const toggleComments = useCallback(() => {
    if (isMobile) setMobilePanelOpen((o) => !o);
    else setCommentsOpen((o) => !o);
  }, [isMobile]);

  // On mobile the comments sheet should be dismissable with the browser/OS
  // Back gesture, without leaving the document. We push a dedicated history
  // entry when it opens; Back pops that entry (closing the sheet) instead of
  // navigating away. Closing via the UI removes the entry we added.
  const sheetHistoryRef = useRef(false);
  useEffect(() => {
    if (!mobilePanelOpen) return;
    window.history.pushState({ aidocsCommentsSheet: true }, "");
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

  const versionItems = versions.data?.items || [];
  const latest =
    currentVersionID(doc.data || {}) ||
    versionID(versionItems[versionItems.length - 1] || {});
  const current = selectedVersion || queryVersion || latest;

  useEffect(() => {
    setCommentPositions(new Map());
    setCommentViewport({ scrollTop: 0, scrollHeight: 1 });
  }, [current]);

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

  const chordKeys = useMemo<ChordKey[]>(
    () => (fullscreen ? ["t", "f", "h"] : ["t", "f", "c", "h"]),
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
      setChordLabel("Documents");
      nav("/app/documents");
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
      nav,
    ],
  );
  const onBareEscape = useCallback(() => {
    if (fullscreen) exitFullscreen();
    else setActiveComment(undefined);
  }, [fullscreen, exitFullscreen]);
  const chord = useEscChord({
    available: chordKeys,
    onRun: runChord,
    onEscape: onBareEscape,
  });

  const ctx = useMemo(
    () => ({
      docId: id,
      version: current,
      comments: comments.data?.items || [],
      commentFilter,
      setCommentFilter,
      commentsLoading: comments.isLoading,
      commentsError: !!comments.error,
      principal: me.data?.principal,
      selection,
      setSelection,
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
    }),
    [
      id,
      current,
      comments.data,
      commentFilter,
      comments.isLoading,
      comments.error,
      me.data,
      selection,
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
    ],
  );

  if (doc.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-3 h-7 w-72" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }
  if (doc.error) {
    if (doc.error instanceof APIError) {
      if (doc.error.status === 403) {
        return <AccessDeniedState documentID={id} />;
      }
      if (doc.error.status === 404) {
        return (
          <DocumentErrorState
            title="Document not found"
            description="This document may have been deleted, or the link may be incorrect."
          />
        );
      }
      if (doc.error.code === "group_membership_unavailable") {
        return (
          <DocumentErrorState
            title="Group access is temporarily unavailable"
            description="Google Group membership could not be refreshed. Try again shortly; stale group access has not been used."
          />
        );
      }
    }
    return (
      <DocumentErrorState
        title="Could not load document"
        description="Something went wrong while loading this document. Please try again."
      />
    );
  }
  if (!doc.data) return null;

  return (
    <DocProvider value={ctx}>
      {fullscreen ? (
        <div className="relative h-full bg-[var(--color-surface-muted)]">
          {showFullscreenHint ? (
            <div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-full bg-[var(--color-surface)] px-6 py-3 text-base font-semibold text-[var(--color-fg)] shadow-xl ring-1 ring-[var(--color-border)]">
              <span className="hidden sm:inline">
                Esc to exit · Esc t theme · Esc h home
              </span>
              <span className="sm:hidden">Go back to exit full screen</span>
            </div>
          ) : null}
          {current ? <RenderFrame /> : <Center>No version available.</Center>}
          <Keycast state={chord} available={chordKeys} label={chordLabel} />
        </div>
      ) : (
        <motion.div
          className="flex h-full flex-col"
          initial="hidden"
          animate="visible"
          variants={pageStagger}
        >
          <motion.div variants={barSlide}>
            <DocBar
              title={docTitle(doc.data)}
              docId={id}
              owner={doc.data.owner}
              principal={me.data?.principal}
              accountUser={me.data?.user || me.data?.principal}
              parentFolder={doc.data.parent_folder}
              current={current}
              latest={latest}
              versions={versions.data?.items || []}
              labels={doc.data.labels || []}
              onSelectVersion={setSelectedVersion}
              commentsOpen={isMobile ? mobilePanelOpen : commentsOpen}
              onToggleComments={toggleComments}
              shareOpen={shareOpen}
              onShareOpenChange={setShareOpen}
            />
          </motion.div>
          <motion.div variants={contentFade} className="flex flex-1 overflow-hidden">
            <section className="relative min-w-0 flex-1 bg-[var(--color-surface-muted)]">
              {current ? <RenderFrame /> : <Center>No version available.</Center>}
              <Keycast state={chord} available={chordKeys} label={chordLabel} />
            </section>
            <AnimatePresence initial={false}>
              {commentsOpen && !isMobile && (
                <motion.aside
                  key="comment-rail"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 360, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ type: "spring", duration: 0.35, bounce: 0 }}
                  className="relative hidden shrink-0 overflow-hidden bg-[var(--color-surface-muted)] md:block"
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
