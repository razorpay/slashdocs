import {
  useCallback,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Center, EmptyState, Skeleton } from "@/components/ui/misc";
import { api, type Comment } from "@/api";
import { cn } from "@/lib/cn";
import { principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { layoutCommentRail } from "@/lib/comment-rail";
import type { MentionDraft } from "@/lib/comment-mentions";
import {
  COMMENT_FILTERS,
  COMMENT_STATUS,
  type CommentFilter,
  matchesCommentFilter,
} from "@/lib/constants";
import { NotificationToggle } from "@/components/notification-toggle";
import type { CommentDraft } from "@/lib/comment-drafts";
import { useSelf } from "@/lib/hooks";
import { useDoc } from "./doc-context";
import {
  ComposeField,
  Message,
  MoreMenu,
  PersonAvatar,
  ReplyRow,
  Replies,
  ResolveButton,
} from "./doc-comment-parts";

export function Comments({ mobile = false }: { mobile?: boolean }) {
  const {
    docId,
    comments,
    commentsLoading,
    commentsError,
    notifications,
    drafts,
    commentFilter: filter,
    setCommentFilter: setFilter,
    activeComment,
    setActiveComment,
  } = useDoc();
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => setHeaderHeight(header.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const items = useMemo(
    () => comments.filter((c) => matchesCommentFilter(c.status, filter)),
    [comments, filter],
  );

  const chooseFilter = (next: CommentFilter) => {
    if (next === filter) return;
    setFilter(next);
    // Switching filters only changes which threads are listed; it must not
    // move the reader. Activating the first thread of the new filter dragged
    // the document to the top of the rail whenever that thread had no known
    // position yet (every resolved thread, because the default Open filter
    // does not paint their highlights). Keep the active thread only while the
    // new filter still lists it.
    if (
      activeComment &&
      !comments.some(
        (c) => c.id === activeComment && matchesCommentFilter(c.status, next),
      )
    ) {
      setActiveComment(undefined);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col border-l border-[var(--color-border)]"
      aria-label="Document comments"
    >
      <div
        ref={headerRef}
        className="shrink-0 border-b border-[var(--color-border)] px-4 pt-3"
      >
        <div className="flex items-center gap-2 pr-10 md:pr-0">
          <h2 className="text-sm font-semibold">Comments</h2>
          {!commentsLoading && !commentsError && (
            <span
              className="text-xs text-[var(--color-fg-muted)] tabular-nums"
              aria-label={`${items.length} comment threads (${filter})`}
            >
              {items.length}
            </span>
          )}
          {notifications && (
            <div className="ml-auto">
              <NotificationToggle documentId={docId} />
            </div>
          )}
        </div>
        <div
          role="group"
          aria-label="Filter comments"
          className="mt-1 flex gap-4 text-xs"
        >
          {COMMENT_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => chooseFilter(f)}
              className={cn(
                "min-h-10 min-w-10 border-b-2 px-1 capitalize transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]",
                filter === f
                  ? "border-[var(--color-accent)] font-medium text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {mobile ? (
        <div
          data-comment-scroll
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {drafts.length > 0 ? (
            <div className="space-y-3 p-4">
              {drafts.map((draft) => (
                <CommentComposer key={draft.id} draft={draft} />
              ))}
            </div>
          ) : null}
          {commentsLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-20 w-full rounded-md" />
              <Skeleton className="h-20 w-full rounded-md" />
            </div>
          ) : commentsError ? (
            <Center>Could not load comments.</Center>
          ) : items.length === 0 ? (
            drafts.length === 0 && (
              <div className="p-4">
                <CommentsEmptyState filter={filter} />
              </div>
            )
          ) : (
            <div className="space-y-3 p-3">
              {items.map((c) => (
                <CommentCard key={c.id} c={c} docId={docId} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CommentRail comments={items} filter={filter} topInset={headerHeight} />
        </div>
      )}
    </div>
  );
}

function CommentsEmptyState({ filter }: { filter: CommentFilter }) {
  return (
    <EmptyState
      icon={<MessageSquareText className="h-5 w-5" />}
      title={
        filter === COMMENT_STATUS.resolved
          ? "No resolved comments yet"
          : filter === COMMENT_STATUS.open
            ? "No open comments"
            : "No comments yet"
      }
      description={
        filter === COMMENT_STATUS.resolved
          ? "Resolved conversations will appear here."
          : "Select text in the document to start a thread."
      }
    />
  );
}

// Typing stays in local state and reaches storage after a short pause, so a
// keystroke does not re-render the whole page.
const DRAFT_SAVE_DELAY = 300;

function CommentComposer({ draft }: { draft: CommentDraft }) {
  const {
    docId,
    activeComment,
    setActiveComment,
    unanchoredComments,
    saveDraft,
    discardDraft,
    principal,
  } = useDoc();
  const q = useQueryClient();
  const formRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<MentionDraft>(() => ({
    body: draft.body,
    mentions: draft.mentions,
  }));
  const unsaved = useRef<MentionDraft | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (unsaved.current) saveDraft(draft.id, unsaved.current);
    unsaved.current = null;
  }, [draft.id, saveDraft]);
  const edit = (next: MentionDraft) => {
    setText(next);
    unsaved.current = next;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, DRAFT_SAVE_DELAY);
  };
  useEffect(() => save, [save]);

  const active = activeComment === draft.id;
  useEffect(() => {
    if (active)
      formRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [active]);

  const create = useMutation({
    mutationFn: () =>
      api.createComment(
        docId,
        draft.version,
        text.body,
        draft.quote,
        draft.anchor,
        text.mentions,
      ),
    onSuccess: () => {
      unsaved.current = null;
      discardDraft(draft.id);
      toast.success("Comment added.");
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not add comment")),
  });

  const discard = () => {
    unsaved.current = null;
    discardDraft(draft.id);
  };
  const discardOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") discard();
  };

  const self = useSelf(principal);
  const { quote } = draft;
  // Laid out like a thread card: who is writing, what they picked, then the
  // same field and send button as a reply.
  return (
    <div
      ref={formRef}
      onFocusCapture={() => setActiveComment(draft.id)}
      onKeyDown={discardOnEscape}
      className={cn(
        "overflow-hidden rounded-xl bg-[var(--color-surface)]",
        active && "ring-[1.5px] ring-inset ring-[var(--color-accent)]",
      )}
    >
      <div className="px-3 pb-1 pt-3">
        <div className="flex min-h-6 items-center gap-2">
          {self ? <PersonAvatar who={self} /> : null}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {self ? principalLabel(self) : "New comment"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={discard}
            aria-label="Cancel comment"
            className="-my-1 h-7 w-7 shrink-0 text-[var(--color-fg-muted)]"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {unanchoredComments.has(draft.id) && (
          <Badge variant="warning" className="ml-7 mt-1">
            Text not found in this version
          </Badge>
        )}
        {quote ? (
          <blockquote className="ml-7 mt-1 rounded-r-md border-l-2 border-[var(--color-accent)] bg-[var(--color-surface-muted)] py-1.5 pl-2 pr-2 text-xs leading-relaxed break-words text-[var(--color-fg-muted)]">
            {quote.length > 160 ? quote.slice(0, 160) + "…" : quote}
          </blockquote>
        ) : null}
      </div>
      <div className="px-3 pb-3 pt-2">
        <ComposeField
          value={text}
          onChange={edit}
          onSubmit={() => create.mutate()}
          pending={create.isPending}
          placeholder="Add a comment…"
          sendLabel="Post comment"
          autoFocus={active}
        />
      </div>
    </div>
  );
}

const RAIL_CARD_ESTIMATE = 190;
const RAIL_COMPOSER_ESTIMATE = 210;

function CommentRail({
  comments: timelineComments,
  filter,
  topInset,
}: {
  comments: Comment[];
  filter: CommentFilter;
  topInset: number;
}) {
  const {
    docId,
    commentsLoading,
    commentsError,
    version,
    drafts,
    activeComment,
    commentPositions,
    commentViewport,
    scrollDocumentTo,
    registerCommentRailSync,
  } = useDoc();
  const railRef = useRef<HTMLDivElement>(null);
  const applyingDocumentScroll = useRef(false);
  const scrollSyncFrame = useRef(0);
  const [railHeight, setRailHeight] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => setRailHeight(rail.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  const layoutItems = useMemo(() => {
    const item = (id: string, top: number | undefined, estimate: number) => ({
      id,
      anchorTop: (top ?? 0) - topInset,
      height: heights.get(id) ?? estimate,
      atStart: top === undefined,
    });
    return [
      ...timelineComments.map((comment) =>
        item(comment.id, commentPositions.get(comment.id)?.top, RAIL_CARD_ESTIMATE),
      ),
      // A new draft sits at its selection until its highlight reports a
      // position. A draft whose text is gone sits at the start.
      ...drafts.map((draft) =>
        item(
          draft.id,
          commentPositions.get(draft.id)?.top ??
            (draft.version === version ? draft.top : undefined),
          RAIL_COMPOSER_ESTIMATE,
        ),
      ),
    ];
  }, [commentPositions, drafts, heights, timelineComments, topInset, version]);
  const priorityId = layoutItems.find(
    (item) => item.id === activeComment && !item.atStart,
  )?.id;
  const priorityMaxHeight = Math.max(1, railHeight - 24);

  const timelineHeight = Math.max(
    commentViewport.scrollHeight - topInset,
    railHeight,
    1,
  );

  const placements = useMemo(
    () =>
      layoutCommentRail(layoutItems, timelineHeight, {
        priorityId,
        viewport: { top: commentViewport.scrollTop, height: railHeight },
      }),
    [layoutItems, timelineHeight, priorityId, commentViewport.scrollTop, railHeight],
  );
  const contentHeight = Math.max(
    timelineHeight,
    ...placements.map((placement) => placement.y + placement.height + 12),
  );
  const commentByID = useMemo(
    () => new Map(timelineComments.map((comment) => [comment.id, comment])),
    [timelineComments],
  );
  const draftByID = useMemo(
    () => new Map(drafts.map((draft) => [draft.id, draft])),
    [drafts],
  );
  const onHeight = useCallback((id: string, height: number) => {
    setHeights((current) => {
      if (Math.abs((current.get(id) || 0) - height) < 1) return current;
      const next = new Map(current);
      next.set(id, height);
      return next;
    });
  }, []);

  const applyDocumentScroll = useCallback((top: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const target = Math.max(0, Math.min(top, rail.scrollHeight - rail.clientHeight));
    if (Math.abs(rail.scrollTop - target) < 0.5) return;
    if (scrollSyncFrame.current) cancelAnimationFrame(scrollSyncFrame.current);
    applyingDocumentScroll.current = true;
    rail.scrollTop = target;
    scrollSyncFrame.current = requestAnimationFrame(() => {
      applyingDocumentScroll.current = false;
      scrollSyncFrame.current = 0;
    });
  }, []);

  useLayoutEffect(() => {
    applyDocumentScroll(commentViewport.scrollTop);
  }, [applyDocumentScroll, commentViewport.scrollTop, contentHeight]);

  const revealedComment = useRef<string | undefined>(undefined);
  const [linkParams] = useSearchParams();
  const linkedComment = linkParams.get("comment");
  useLayoutEffect(() => {
    if (revealedComment.current === activeComment) return;
    if (!activeComment) {
      revealedComment.current = undefined;
      return;
    }
    const rail = railRef.current;
    const placement = placements.find((item) => item.id === activeComment);
    if (!rail || !placement || !heights.has(activeComment)) return;
    revealedComment.current = activeComment;
    if (!placement.atStart) return;
    // Reveal unanchored threads where they already are. Clicking a visible
    // card must not reorder the stack or reset the document's scroll position.
    const card = Array.from(
      rail.querySelectorAll<HTMLElement>("article[data-comment-id]"),
    ).find((element) => element.dataset.commentId === activeComment);
    if (!card) return;
    const target =
      Array.from(card.querySelectorAll<HTMLElement>("[data-comment-id]")).find(
        (element) => element.dataset.commentId === linkedComment,
      ) || card;
    const bounds = target.getBoundingClientRect();
    const viewport = rail.getBoundingClientRect();
    const delta =
      bounds.top < viewport.top
        ? bounds.top - viewport.top - 12
        : bounds.top >= viewport.bottom
          ? bounds.top -
            viewport.bottom +
            Math.min(bounds.height, rail.clientHeight - 24) +
            12
          : 0;
    if (delta) {
      const top = rail.scrollTop + delta;
      applyDocumentScroll(top);
      scrollDocumentTo(top);
    }
  }, [
    activeComment,
    placements,
    heights,
    linkedComment,
    applyDocumentScroll,
    scrollDocumentTo,
  ]);

  useEffect(() => {
    registerCommentRailSync(applyDocumentScroll);
    return () => registerCommentRailSync(null);
  }, [applyDocumentScroll, registerCommentRailSync]);

  useEffect(
    () => () => {
      if (scrollSyncFrame.current) cancelAnimationFrame(scrollSyncFrame.current);
    },
    [],
  );

  return (
    <div
      ref={railRef}
      className="relative h-full overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
      onScroll={(event) => {
        if (applyingDocumentScroll.current) return;
        scrollDocumentTo(event.currentTarget.scrollTop);
      }}
    >
      {commentsLoading ? (
        <div className="sticky top-0 space-y-3 px-3 py-3">
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="h-28 w-full rounded-md" />
        </div>
      ) : commentsError ? (
        <div className="sticky top-0 px-3 py-3">
          <div className="rounded-md bg-[var(--color-surface)] p-3 text-sm text-[var(--color-fg-muted)] shadow-lg ring-1 ring-[var(--color-border)]">
            Could not load comments.
          </div>
        </div>
      ) : (
        <div className="relative min-h-full" style={{ height: contentHeight }}>
          {timelineComments.length === 0 && drafts.length === 0 && (
            <div className="sticky top-0 p-4">
              <CommentsEmptyState filter={filter} />
            </div>
          )}
          {placements.map((placement) => {
            const comment = commentByID.get(placement.id);
            const draft = draftByID.get(placement.id);
            if (!comment && !draft) return null;
            return (
              <MeasuredRailItem
                key={placement.id}
                id={placement.id}
                y={placement.y}
                connected={!placement.atStart}
                priority={placement.id === priorityId}
                maxHeight={railHeight > 0 ? priorityMaxHeight : undefined}
                connectorOffset={Math.max(
                  12,
                  Math.min(
                    placement.height - 12,
                    placement.anchorTop - placement.y + 9,
                  ),
                )}
                onHeight={onHeight}
              >
                {draft ? (
                  <CommentComposer draft={draft} />
                ) : (
                  <CommentCard c={comment!} docId={docId} autoReveal={false} />
                )}
              </MeasuredRailItem>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MeasuredRailItem({
  id,
  y,
  connected,
  priority,
  maxHeight,
  connectorOffset,
  onHeight,
  children,
}: {
  id: string;
  y: number;
  connected: boolean;
  priority: boolean;
  maxHeight?: number;
  connectorOffset: number;
  onHeight: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [linkParams] = useSearchParams();
  const linkedComment = linkParams.get("comment");
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!priority || !container || !linkedComment) return;
    const target = Array.from(
      container.querySelectorAll<HTMLElement>("[data-comment-id]"),
    ).find((element) => element.dataset.commentId === linkedComment);
    if (target) {
      // Scroll only the thread, keeping its document highlight in place.
      container.scrollTop +=
        target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    }
  }, [priority, linkedComment, maxHeight]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => onHeight(id, element.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onHeight]);
  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-x-3 top-0",
        !priority &&
          "transition-[top] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ top: y }}
    >
      {connected ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -left-3 h-px w-3 bg-[var(--color-border-strong)]"
          style={{ top: priority ? connectorOffset : 20 }}
        />
      ) : null}
      <div
        ref={contentRef}
        className={
          priority ? "overflow-y-auto overscroll-contain rounded-md" : undefined
        }
        style={{ maxHeight: priority ? maxHeight : undefined }}
      >
        {children}
      </div>
    </div>
  );
}

function CommentCard({
  c,
  docId,
  autoReveal = true,
}: {
  c: Comment;
  docId: string;
  autoReveal?: boolean;
}) {
  const { activeComment, setActiveComment, signIn, unanchoredComments } = useDoc();
  const cardRef = useRef<HTMLElement>(null);
  const active = activeComment === c.id;
  const [linkParams] = useSearchParams();
  const linkedComment = linkParams.get("comment");
  useEffect(() => {
    const card = cardRef.current;
    if (!active || !autoReveal || !card) return;
    const container = card.closest<HTMLElement>("[data-comment-scroll]");
    if (!container) return;
    const target =
      Array.from(card.querySelectorAll<HTMLElement>("[data-comment-id]")).find(
        (element) => element.dataset.commentId === linkedComment,
      ) || card;
    container.scrollTop +=
      target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
  }, [active, autoReveal, linkedComment]);
  const resolved = c.status === COMMENT_STATUS.resolved;
  const toggleActive = () => setActiveComment(active ? undefined : c.id);
  // The reply field is always there on an open thread; on a resolved one,
  // once the thread is picked.
  const showReply = !signIn && (!resolved || active);
  return (
    <article
      ref={cardRef}
      data-comment-id={c.id}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      // A card: the thread's messages, then the reply field.
      className={cn(
        "group cursor-pointer overflow-hidden rounded-xl bg-[var(--color-surface)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
        // Fill only, no stroke or shadow: the picked one gets a thin accent ring.
        active && "ring-[1.5px] ring-inset ring-[var(--color-accent)]",
      )}
      onClick={toggleActive}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLTextAreaElement) setActiveComment(c.id);
      }}
      onKeyDown={(e) => {
        // Only toggle when the card itself is focused, not when typing in the
        // reply field or activating a nested button.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleActive();
        }
      }}
    >
      <div className="px-3 py-3">
        {unanchoredComments.has(c.id) && (
          <Badge variant="warning" className="mb-2">
            Highlight not currently visible
          </Badge>
        )}
        <Message
          c={c}
          docId={docId}
          thread
          actions={
            <>
              {resolved ? (
                <span className="shrink-0 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  Resolved
                </span>
              ) : null}
              {/* Shown on hover and while the thread is open, so a list of
                  threads reads as text, not as rows of icons. */}
              <span
                className={cn(
                  "-my-1 ml-auto flex shrink-0 items-center transition-opacity duration-150",
                  active
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}
              >
                {!signIn ? (
                  <ResolveButton c={c} docId={docId} className="h-7 w-7" />
                ) : null}
                <MoreMenu c={c} docId={docId} thread className="h-7 w-7" />
              </span>
            </>
          }
        />
        <Replies c={c} docId={docId} />
        {/* The reply field sits at the replies' level: what you type there
            becomes one of them. */}
        {showReply ? (
          <div className="ml-7 mt-3" onClick={(event) => event.stopPropagation()}>
            <ReplyRow c={c} docId={docId} className="border-0 p-0" />
          </div>
        ) : null}
      </div>
    </article>
  );
}
