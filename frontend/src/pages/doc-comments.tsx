import {
  useCallback,
  useId,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import {
  CheckCircle2,
  Link2,
  MessageSquareText,
  Pencil,
  Reply,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Center, EmptyState, Skeleton } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/input";
import { api, type Comment, type UserPrincipal } from "@/api";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format-date";
import { queryKeys } from "@/lib/queryKeys";
import { layoutCommentRail } from "@/lib/comment-rail";
import { samePrincipal } from "@/lib/principals";
import {
  emptyMentionDraft,
  getMentionTarget,
  type MentionTarget,
  inferTextareaEdit,
  insertMention,
  MAX_COMMENT_MENTIONS,
  mentionPrincipalLabel,
  mentionTextSegments,
  reconcileMentionDraft,
  type MentionDraft,
  type TextSelection,
} from "@/lib/comment-mentions";
import {
  COMMENT_FILTERS,
  COMMENT_STATUS,
  type CommentFilter,
  matchesCommentFilter,
} from "@/lib/constants";
import { NotificationToggle } from "@/components/notification-toggle";
import type { CommentDraft } from "@/lib/comment-drafts";
import { useDoc } from "./doc-context";
import { ReactionBar } from "./doc-comment-reactions";

function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

function MentionTextarea({
  draft,
  onChange,
  onKeyDown,
  placeholder,
  rows,
  className,
  autoFocus,
}: {
  draft: MentionDraft;
  onChange: (draft: MentionDraft) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const beforeInputSelection = useRef<TextSelection | null>(null);
  // Caret position to apply right after the commit that renders an accepted
  // mention. A layout effect (not requestAnimationFrame) applies it: rAF can
  // fire after further keystrokes and yank the caret back mid-word.
  const caretRestore = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [target, setTarget] = useState<MentionTarget | null>(null);
  const [suggestions, setSuggestions] = useState<UserPrincipal[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const listID = useId();
  const [suggestionQuery, setSuggestionQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const visible =
    open && suggestions.length > 0 && suggestionQuery === target?.query.trim();

  // Use the browser event: React's synthetic beforeinput omits paste and some
  // native edits, which previously cleared every accepted mention on change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const capture = () => {
      beforeInputSelection.current = { start: el.selectionStart, end: el.selectionEnd };
    };
    el.addEventListener("beforeinput", capture);
    return () => el.removeEventListener("beforeinput", capture);
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const height = Math.min(240, suggestions.length * 64);
      setPosition({
        left: rect.left,
        width: rect.width,
        top:
          rect.bottom + height + 8 > window.innerHeight
            ? Math.max(8, rect.top - height - 4)
            : rect.bottom + 4,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, suggestions.length]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const syncTarget = (el: HTMLTextAreaElement) => {
    const nextCaret = el.selectionStart ?? 0;
    setCaret(nextCaret);
    setTarget(
      el.selectionStart === el.selectionEnd
        ? getMentionTarget(el.value, nextCaret, draft.mentions)
        : null,
    );
  };

  useEffect(() => {
    setTarget(getMentionTarget(draft.body, caret, draft.mentions));
  }, [draft.body, draft.mentions, caret]);

  useEffect(() => {
    const query = target?.query.trim() || "";
    if (query.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api.searchUsers(query);
        if (cancelled) return;
        setSuggestionQuery(query);
        setSuggestions(result.items || []);
        setActiveIndex(0);
        setOpen((result.items || []).length > 0);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [target?.query]);

  useLayoutEffect(() => {
    if (caretRestore.current === null) return;
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(caretRestore.current, caretRestore.current);
    }
    caretRestore.current = null;
  });

  const accept = (user: UserPrincipal) => {
    if (!target) return;
    if (draft.mentions.length >= MAX_COMMENT_MENTIONS) {
      toast.error(`A comment can mention up to ${MAX_COMMENT_MENTIONS} people.`);
      setOpen(false);
      return;
    }
    const label = `@${mentionPrincipalLabel(user)}`;
    const nextCaret = target.start + label.length + 1;
    onChange(insertMention(draft, target.start, target.end, user));
    setOpen(false);
    setSuggestions([]);
    setCaret(nextCaret);
    caretRestore.current = nextCaret;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (visible) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(
          (index) => (index - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(suggestions[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Textarea
        ref={ref}
        rows={rows}
        value={draft.body}
        onChange={() => {}}
        onInput={(event) => {
          const el = event.currentTarget;
          const before = beforeInputSelection.current;
          beforeInputSelection.current = null;
          const after = { start: el.selectionStart, end: el.selectionEnd };
          const edit = before
            ? inferTextareaEdit(draft.body, el.value, before, after)
            : null;
          onChange(reconcileMentionDraft(draft, el.value, edit));
          syncTarget(el);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listID : undefined}
        aria-activedescendant={visible ? `${listID}-${activeIndex}` : undefined}
        onClick={(event) => syncTarget(event.currentTarget)}
        onBlur={() => setOpen(false)}
        onKeyUp={(event) => syncTarget(event.currentTarget)}
        onSelect={(event) => syncTarget(event.currentTarget)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
      />
      {visible
        ? createPortal(
            <div
              id={listID}
              role="listbox"
              aria-label="Mention people"
              style={position}
              className="fixed z-[100] max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
            >
              {suggestions.map((user, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    key={user.id || user.email}
                    id={`${listID}-${index}`}
                    role="option"
                    aria-selected={active}
                    type="button"
                    className={`block min-h-10 w-full px-3 py-2 text-left text-sm transition-colors ${active ? "bg-[var(--color-surface-muted)] text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      accept(user);
                    }}
                  >
                    <span className="block truncate font-medium">
                      {mentionPrincipalLabel(user)}
                    </span>
                    {user.email && user.email !== mentionPrincipalLabel(user) ? (
                      <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                        {user.email}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
      {draft.mentions.length > 0 && (
        <p className="mt-1 text-xs text-[var(--color-accent)]" aria-live="polite">
          Mentioned:{" "}
          {[
            ...new Map(
              draft.mentions.map((m) => [
                m.principal.id,
                mentionPrincipalLabel(m.principal),
              ]),
            ).values(),
          ].join(", ")}
        </p>
      )}
      {target && !visible && (
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Choose a person from suggestions to notify them.
        </p>
      )}
    </div>
  );
}

function CommentBody({
  text,
  mentions,
}: {
  text: string;
  mentions: Comment["mentions"];
}) {
  return (
    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
      {mentionTextSegments(text, mentions || []).map((segment, index) =>
        segment.mention ? (
          <span
            key={`${segment.mention.offset}-${segment.mention.principal.type}-${segment.mention.principal.id}`}
            className="rounded bg-[var(--color-accent-muted)] px-1 py-0.5 font-medium text-[var(--color-accent)]"
          >
            {segment.text}
          </span>
        ) : (
          <CommentText key={`text-${index}`} text={segment.text} />
        ),
      )}
    </p>
  );
}

// Only web URLs become links; comment text always goes through React escaping.
function CommentText({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s<>"]+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    let href = part.replace(/[.,!?;:]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      let extra = href.split(close).length - href.split(open).length;
      while (extra > 0 && href.endsWith(close)) {
        href = href.slice(0, -1);
        extra--;
      }
    }
    try {
      if (!["http:", "https:"].includes(new URL(href).protocol)) return part;
    } catch {
      return part;
    }
    return (
      <span key={index}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-current"
          onClick={(event) => event.stopPropagation()}
        >
          {href}
        </a>
        {part.slice(href.length)}
      </span>
    );
  });
}

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
    setActiveComment,
    scrollDocumentTo,
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
    // Let the bridge reveal the first matching highlight after repainting.
    // Sending a scroll-to-top here would interrupt that reveal.
    const first = comments.find((c) => matchesCommentFilter(c.status, next));
    if (!first) scrollDocumentTo(0);
    setActiveComment(first?.id);
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
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4"
        >
          {drafts.map((draft) => (
            <CommentComposer key={draft.id} draft={draft} />
          ))}
          {commentsLoading ? (
            <>
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
            </>
          ) : commentsError ? (
            <Center>Could not load comments.</Center>
          ) : items.length === 0 ? (
            drafts.length === 0 && <CommentsEmptyState filter={filter} />
          ) : (
            items.map((c) => <CommentCard key={c.id} c={c} docId={docId} />)
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
  } = useDoc();
  const q = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
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

  const { quote } = draft;
  return (
    <form
      ref={formRef}
      onFocusCapture={() => setActiveComment(draft.id)}
      className={cn(
        "space-y-2 rounded-md bg-[var(--color-surface)] p-3 shadow-lg ring-1",
        active
          ? "ring-2 ring-[var(--color-border-strong)]"
          : "ring-[var(--color-border)]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (text.body.trim() && !create.isPending) create.mutate();
      }}
    >
      {unanchoredComments.has(draft.id) && (
        <Badge variant="warning">Text not found in this version</Badge>
      )}
      <div className="border-l-2 border-[var(--color-accent)] pl-2 text-xs italic text-[var(--color-fg-muted)]">
        “{quote.length > 80 ? quote.slice(0, 80) + "…" : quote}”
      </div>
      <MentionTextarea
        rows={3}
        draft={text}
        onChange={edit}
        onKeyDown={submitOnModEnter}
        placeholder="Add a comment…"
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={discard}
          aria-label="Cancel comment"
          title="Cancel comment"
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          type="submit"
          aria-label="Post comment"
          title="Post comment (⌘Enter / Ctrl+Enter)"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={!text.body.trim() || create.isPending}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
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
  const q = useQueryClient();
  const { activeComment, setActiveComment, principal, signIn, unanchoredComments } =
    useDoc();
  const cardRef = useRef<HTMLElement>(null);
  const active = activeComment === c.id;
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const reply = useMutation({
    mutationFn: (draft: MentionDraft) =>
      api.createCommentReply(docId, c.id, draft.body, draft.mentions),
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    onError: (e) => toast.error(errorMessage(e, "Could not add reply")),
  });
  const m = useMutation({
    mutationFn: (status: string) => api.patchComment(docId, c.id, { status }),
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    onError: (e) => toast.error(errorMessage(e, "Could not update comment")),
  });
  const mine = samePrincipal(principal, c.author);
  const resolved = c.status === COMMENT_STATUS.resolved;
  const toggleActive = () => setActiveComment(active ? undefined : c.id);
  const replies = c.replies || [];
  // Reply sits on the last message of the thread, just above the composer.
  const replyButton = (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 text-[var(--color-fg-muted)]"
      aria-label="Reply"
      title="Reply"
      onClick={(event) => {
        event.stopPropagation();
        if (signIn) return signIn();
        setReplying(true);
        cardRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
      }}
      aria-expanded={replying}
    >
      <Reply className="h-4 w-4" />
    </Button>
  );
  return (
    <article
      ref={cardRef}
      data-comment-id={c.id}
      role="button"
      tabIndex={0}
      className={`group cursor-pointer rounded-md bg-[var(--color-surface)] p-3 shadow-sm ring-1 transition-shadow duration-200 ease-out hover:shadow-md ${active ? "ring-2 ring-[var(--color-border-strong)]" : "ring-[var(--color-border)]"}`}
      onClick={toggleActive}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLTextAreaElement) setActiveComment(c.id);
      }}
      onKeyDown={(e) => {
        // Only toggle when the card itself is focused, not when typing in the
        // reply composer or activating a nested button.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleActive();
        }
      }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-semibold">
          {c.author.name || c.author.email || c.author.id}
        </span>
        {resolved ? (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" /> resolved
          </Badge>
        ) : (
          <Badge variant="accent">open</Badge>
        )}
      </div>
      {(c.created_at || (resolved && c.resolved_at)) && (
        <div className="mb-1 flex flex-wrap gap-x-3 text-[11px] text-[var(--color-fg-muted)]">
          {c.created_at ? <span>Added {formatTimestamp(c.created_at)}</span> : null}
          {resolved && c.resolved_at ? (
            <span>Resolved {formatTimestamp(c.resolved_at)}</span>
          ) : null}
        </div>
      )}
      {unanchoredComments.has(c.id) && (
        <Badge variant="warning" className="mb-2">
          Highlight not currently visible
        </Badge>
      )}
      {c.selected_text && (
        <blockquote className="mb-2 rounded-r-md border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] py-1.5 pl-2 pr-2 text-xs leading-relaxed break-words text-[var(--color-fg-muted)]">
          {c.selected_text}
        </blockquote>
      )}
      <EditableComment c={c} docId={docId} editing={editing} setEditing={setEditing} />
      <div className="mt-1">
        <ReactionBar c={c} docId={docId}>
          {replies.length === 0 && replyButton}
          <CopyCommentLink commentId={c.id} />
          {mine && !editing && <EditCommentButton onEdit={() => setEditing(true)} />}
          <DeleteCommentButton c={c} docId={docId} canDelete={mine} />
          <Button
            variant="ghost"
            size="icon"
            className={
              resolved
                ? "shrink-0 text-[var(--color-fg-muted)]"
                : "shrink-0 text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
            }
            title={resolved ? "Reopen comment" : "Resolve comment"}
            aria-label={resolved ? "Reopen comment" : "Resolve comment"}
            disabled={m.isPending}
            onClick={(e) => {
              e.stopPropagation();
              if (signIn) return signIn();
              m.mutate(resolved ? COMMENT_STATUS.open : COMMENT_STATUS.resolved);
            }}
          >
            {resolved ? (
              <RotateCcw className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </Button>
        </ReactionBar>
      </div>
      {replies.length > 0 && (
        <div className="mt-1 space-y-1 border-l border-[var(--color-border)] pl-3">
          {replies.map((r, index) => (
            <ReplyItem
              key={r.id}
              r={r}
              docId={docId}
              mine={samePrincipal(principal, r.author)}
            >
              {index === replies.length - 1 && replyButton}
            </ReplyItem>
          ))}
        </div>
      )}
      {replying && (
        <ReplyComposer
          onReply={async (draft) => {
            await reply.mutateAsync(draft);
            setReplying(false);
          }}
          pending={reply.isPending}
        />
      )}
    </article>
  );
}

function ReplyItem({
  r,
  docId,
  mine,
  children,
}: {
  r: Comment;
  docId: string;
  mine: boolean;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      data-comment-id={r.id}
      className="group/reply rounded-md bg-[var(--color-surface-muted)]/50 p-2"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-semibold">
          {r.author.name || r.author.email || r.author.id}
        </span>
      </div>
      {r.created_at ? (
        <div className="mb-1 text-[11px] text-[var(--color-fg-muted)]">
          {formatTimestamp(r.created_at)}
        </div>
      ) : null}
      <EditableComment c={r} docId={docId} editing={editing} setEditing={setEditing} />
      <div className="mt-1">
        <ReactionBar c={r} docId={docId}>
          {children}
          <CopyCommentLink commentId={r.id} />
          {mine && !editing && <EditCommentButton onEdit={() => setEditing(true)} />}
          <DeleteCommentButton c={r} docId={docId} canDelete={mine} />
        </ReactionBar>
      </div>
    </div>
  );
}

function EditableComment({
  c,
  docId,
  editing,
  setEditing,
}: {
  c: Comment;
  docId: string;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  if (!editing)
    return (
      <div>
        <CommentBody text={c.body} mentions={c.mentions} />
        {c.edited && <div className="text-xs text-[var(--color-fg-muted)]">edited</div>}
      </div>
    );
  return <CommentEditForm c={c} docId={docId} setEditing={setEditing} />;
}

function CommentEditForm({
  c,
  docId,
  setEditing,
}: {
  c: Comment;
  docId: string;
  setEditing: (editing: boolean) => void;
}) {
  const q = useQueryClient();
  const [draft, setDraft] = useState<MentionDraft>({
    body: c.body,
    mentions: c.mentions || [],
  });
  const save = useMutation({
    mutationFn: () => api.patchComment(docId, c.id, draft),
    onSuccess: async () => {
      await q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      setEditing(false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update comment")),
  });
  return (
    <form
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.body.trim() && !save.isPending) save.mutate();
      }}
    >
      <MentionTextarea
        autoFocus
        rows={3}
        draft={draft}
        onChange={setDraft}
        onKeyDown={submitOnModEnter}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cancel edit"
          title="Cancel edit"
          disabled={save.isPending}
          onClick={() => setEditing(false)}
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          type="submit"
          size="icon"
          aria-label="Save comment"
          title="Save comment (⌘Enter / Ctrl+Enter)"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={!draft.body.trim() || save.isPending}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

function EditCommentButton({ onEdit }: { onEdit: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="shrink-0 text-[var(--color-fg-muted)]"
      aria-label="Edit comment"
      title="Edit comment"
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
    >
      <Pencil className="h-4 w-4" />
    </Button>
  );
}

function ReplyComposer({
  onReply,
  pending,
}: {
  onReply: (draft: MentionDraft) => Promise<void>;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<MentionDraft>(emptyMentionDraft);
  return (
    <form
      className="mt-1 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.body.trim() || pending) return;
        const submittedDraft = draft;
        void onReply(submittedDraft)
          .then(() => {
            setDraft((current) =>
              current === submittedDraft ? emptyMentionDraft() : current,
            );
          })
          // The mutation displays the error; retaining the draft lets the user retry.
          .catch(() => undefined);
      }}
    >
      <MentionTextarea
        autoFocus
        rows={1}
        draft={draft}
        onChange={setDraft}
        placeholder="Reply…"
        onKeyDown={submitOnModEnter}
        className="min-h-9 text-sm"
      />
      <Button
        size="icon"
        type="submit"
        aria-label="Post reply"
        disabled={!draft.body.trim() || pending}
        title="Post reply (⌘Enter / Ctrl+Enter)"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        className="shrink-0"
      >
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

function DeleteCommentButton({
  c,
  docId,
  canDelete,
  className = "",
}: {
  c: Comment;
  docId: string;
  canDelete: boolean;
  className?: string;
}) {
  const q = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteComment(docId, c.id),
    onSuccess: () => {
      toast.success("Deleted.");
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not delete comment")),
  });
  if (!canDelete) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`shrink-0 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 ${className}`}
          aria-label="Delete comment"
          title="Delete comment"
          onClick={(e) => e.stopPropagation()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogTitle>Delete comment?</AlertDialogTitle>
        <AlertDialogDescription>
          This removes the comment permanently. Replies are removed when deleting a
          thread starter.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={() => del.mutate()}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CopyCommentLink({ commentId }: { commentId: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      aria-label="Copy comment link"
      title="Copy comment link"
      className="shrink-0 text-[var(--color-fg-muted)]"
      onClick={(event) => {
        event.stopPropagation();
        // The link opens this document page, without its version or full
        // screen.
        const url = new URL(window.location.pathname, window.location.origin);
        url.searchParams.set("comment", commentId);
        void navigator.clipboard.writeText(url.toString()).then(
          () => toast.success("Comment link copied."),
          () => toast.error("Could not copy the comment link."),
        );
      }}
    >
      <Link2 className="h-4 w-4" />
    </Button>
  );
}
