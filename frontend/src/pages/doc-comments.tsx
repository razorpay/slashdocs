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
import { MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Center, EmptyState, Skeleton } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/input";
import { api, type Comment, type UserPrincipal } from "@/api";
import { cn } from "@/lib/cn";
import { principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { layoutCommentRail } from "@/lib/comment-rail";
import {
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
import {
  ComposeField,
  Message,
  MoreMenu,
  PersonAvatar,
  ReplyRow,
  Replies,
  ResolveButton,
  useSelf,
} from "./doc-comment-parts";

export function MentionTextarea({
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

export function CommentBody({
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

  const self = useSelf();
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
