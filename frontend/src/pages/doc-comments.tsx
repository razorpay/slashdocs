import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CloudOff, MapPin, MessageSquareText, X } from "lucide-react";
import { api, type Comment, type Principal } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  RetryButton,
  Skeleton,
  type RetryQuery,
} from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { NotificationToggle } from "@/components/notification-toggle";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { principalLabel, samePrincipal } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
import { anchorLabel } from "@/lib/comment-pins";
import { useDraftText, type CommentDraft } from "@/lib/comment-drafts";
import { COMMENT_FILTERS, COMMENT_STATUS, matchesCommentFilter } from "@/lib/constants";
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
import { CommentBody } from "./doc-comment-text";

const QUOTE_PREVIEW = 160;

function Quote({ text }: { text: string }) {
  if (!text) return null;
  return (
    <blockquote className="mt-1 rounded-r-md border-l-2 border-[var(--color-accent)] bg-[var(--color-surface-muted)] py-1.5 pl-2 pr-2 text-xs leading-relaxed break-words text-[var(--color-fg-muted)]">
      {text.length > QUOTE_PREVIEW ? text.slice(0, QUOTE_PREVIEW) + "…" : text}
    </blockquote>
  );
}

// A small header action, which grows to a 40px target on a touch screen.
const HEADER_ACTION = "h-7 w-7 pointer-coarse:h-10 pointer-coarse:w-10";

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      className={cn("-my-1 shrink-0 text-[var(--color-fg-muted)]", HEADER_ACTION)}
    >
      <X className="h-4 w-4" />
    </Button>
  );
}

// CommentComposer writes a new thread: who writes it, what it is on, and the
// same field and send button as a reply.
export function CommentComposer({ draft }: { draft: CommentDraft }) {
  const {
    docId,
    setActiveComment,
    unanchoredComments,
    saveDraft,
    discardDraft,
    principal,
  } = useDoc();
  const q = useQueryClient();
  const [text, edit] = useDraftText(
    { body: draft.body, mentions: draft.mentions },
    (next) => saveDraft(draft.id, next),
  );

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
    onSuccess: (created) => {
      discardDraft(draft.id);
      // The new thread opens where the draft was.
      setActiveComment(created.id);
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    // The text stays in the field, and the toast sends it again.
    onError: (e) =>
      toast.error(errorMessage(e, "Could not add comment"), {
        action: { label: "Retry", onClick: () => create.mutate() },
      }),
  });

  // Only this button deletes what was typed. Esc and a click outside close
  // the popover and keep the draft, and an empty one goes as it closes.
  const discard = () => discardDraft(draft.id);

  const self = useSelf(principal);
  return (
    <div className="px-3 pb-3 pt-3">
      <div className="flex min-h-6 items-center gap-2">
        {self ? <PersonAvatar who={self} /> : null}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {self ? principalLabel(self) : "New comment"}
        </span>
        <CloseButton label="Discard comment" onClick={discard} />
      </div>
      <div className="ml-7">
        {unanchoredComments.has(draft.id) && (
          <Badge variant="warning" className="mt-1">
            Not found in this version
          </Badge>
        )}
        <Quote text={draft.quote} />
      </div>
      <div className="pt-2">
        <ComposeField
          value={text}
          onChange={edit}
          onSubmit={() => create.mutate()}
          pending={create.isPending}
          placeholder="Add a comment…"
          sendLabel="Post comment"
          autoFocus
        />
      </div>
    </div>
  );
}

// CommentThread is a whole thread, for its popover: the first comment with
// the thread's actions, the replies set in under it, and the reply field.
export function CommentThread({ c, onClose }: { c: Comment; onClose: () => void }) {
  const { docId, signIn, unanchoredComments } = useDoc();
  const ref = useRef<HTMLElement>(null);
  const [params] = useSearchParams();
  const linked = params.get("comment");
  // A link to a reply shows that reply.
  useLayoutEffect(() => {
    const target = Array.from(
      ref.current?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? [],
    ).find((el) => el.dataset.commentId === linked);
    target?.scrollIntoView({ block: "nearest" });
  }, [linked]);
  const resolved = c.status === COMMENT_STATUS.resolved;
  return (
    <article ref={ref} data-comment-id={c.id} className="px-3 py-3">
      {unanchoredComments.has(c.id) && (
        <Badge variant="warning" className="mb-2">
          Not found in this version
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
            <span className="-my-1 ml-auto flex shrink-0 items-center">
              {!signIn ? (
                <ResolveButton c={c} docId={docId} className={HEADER_ACTION} />
              ) : null}
              <MoreMenu c={c} docId={docId} thread className={HEADER_ACTION} />
              <CloseButton label="Close comment" onClick={onClose} />
            </span>
          </>
        }
      />
      <Replies c={c} docId={docId} />
      {/* The reply field sits at the replies' level: what you type there
          becomes one of them. It stays in view while a long thread scrolls. */}
      {!signIn ? (
        <div className="sticky bottom-0 -mx-3 -mb-3 mt-1 bg-[var(--color-surface)] pb-3 pl-10 pr-3 pt-2">
          <ReplyRow c={c} docId={docId} className="border-0 p-0" />
        </div>
      ) : null}
    </article>
  );
}

const LIST_FILTERS = [...COMMENT_FILTERS, "for you"] as const;
const LIST_ROW =
  "w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:-outline-offset-2 aria-[current]:bg-[var(--color-accent-muted)]";
const countLabel = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
type ListFilter = (typeof LIST_FILTERS)[number];

// mentions tells whether a thread mentions the reader, in its first comment
// or a reply.
function mentions(c: Comment, self?: Principal): boolean {
  return [c, ...(c.replies ?? [])].some((m) =>
    m.mentions?.some((mention) => samePrincipal(mention.principal, self)),
  );
}

// CommentsList is the comment history: every thread, open or resolved, also
// those whose text or element is gone. Picking one opens it in place.
export function CommentsList({
  showsLatest,
  onPick,
  onPlacePin,
  retry,
  onClose,
}: {
  // The version on screen is the latest one, which the server places the
  // comments of the list on.
  showsLatest: boolean;
  onPick: (id: string) => void;
  onPlacePin: () => void;
  // The comments query, to load again when it failed.
  retry: RetryQuery;
  onClose: () => void;
}) {
  const {
    docId,
    comments,
    commentsLoading,
    commentsError,
    notifications,
    principal,
    signIn,
    unanchoredComments,
    activeComment,
    drafts,
    discardDraft,
  } = useDoc();
  const self = useSelf(principal);
  const [filter, setFilter] = useState<ListFilter>("all");
  // The open thread is marked in the list, and scrolls into view.
  const activeRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [activeComment, filter]);
  // The document shows open threads, so the bridge knows which of those it
  // could not place. The server knows it for the rest, but on the latest
  // version only, so on an earlier one only the bridge tells.
  const lost = (c: Comment) =>
    unanchoredComments.has(c.id) ||
    (showsLatest && c.current_placement?.status === "orphaned");
  const items = comments.filter((c) =>
    filter === "for you"
      ? mentions(c, principal)
      : matchesCommentFilter(c.status, filter),
  );
  // Drafts are the reader's own open threads, not yet sent.
  const unsent =
    filter === "all" || filter === COMMENT_STATUS.open
      ? drafts.filter((d) => d.body.trim())
      : [];
  const drafted = unsent.length ? countLabel(unsent.length, "draft") : "";
  return (
    <div className="flex max-h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--color-border)] px-4 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Comments</h2>
          {!commentsLoading && !commentsError && (
            <span
              className="text-xs text-[var(--color-fg-muted)] tabular-nums"
              aria-label={[`${items.length} comment threads (${filter})`, drafted]
                .filter(Boolean)
                .join(", ")}
            >
              {items.length}
              {drafted && ` · ${drafted}`}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {notifications && <NotificationToggle documentId={docId} />}
            {signIn ? (
              <Button type="button" variant="outline" size="sm" onClick={onPlacePin}>
                Sign in to comment
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onPlacePin}
                aria-label="Comment on a spot"
                tooltip="Comment on a spot (C)"
                className="h-8 w-8 text-[var(--color-fg-muted)]"
              >
                <MapPin className="h-4 w-4" />
              </Button>
            )}
            <CloseButton label="Close comments" onClick={onClose} />
          </span>
        </div>
        <div
          role="group"
          aria-label="Filter comments"
          className="mt-1 flex gap-4 text-xs"
        >
          {(signIn ? COMMENT_FILTERS : LIST_FILTERS).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "min-h-10 min-w-10 border-b-2 px-1 capitalize transition-colors",
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {unsent.length ? (
          <ul aria-label="Drafts" className="mb-1 space-y-1">
            {unsent.map((d) => (
              <li key={d.id} className="relative">
                <button
                  ref={d.id === activeComment ? activeRow : undefined}
                  type="button"
                  onClick={() => onPick(d.id)}
                  aria-current={d.id === activeComment ? "true" : undefined}
                  className={LIST_ROW}
                >
                  <span className="flex items-center gap-2">
                    {self ? <PersonAvatar who={self} /> : null}
                    <span className="text-xs font-semibold text-[var(--color-accent)]">
                      Draft
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--color-fg-muted)]">
                      <RelativeTime iso={new Date(d.updatedAt).toISOString()} />
                    </span>
                  </span>
                  <span className="ml-7 block">
                    <Quote
                      text={anchorLabel({ selected_text: d.quote, anchor: d.anchor })}
                    />
                    <span className="mt-1 block">
                      <CommentBody text={d.body} mentions={d.mentions} preview />
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => discardDraft(d.id)}
                  className="absolute right-1 top-1 h-7 px-2 text-xs text-[var(--color-fg-muted)]"
                >
                  Discard
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {commentsLoading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-16 w-full rounded-md" />
          </div>
        ) : commentsError ? (
          <EmptyState
            icon={<CloudOff className="h-5 w-5" />}
            title="Could not load comments"
            description="Check your connection, then try again."
            action={<RetryButton query={retry} variant="outline" size="sm" />}
          />
        ) : items.length === 0 ? (
          unsent.length ? null : (
            <CommentsEmptyState filter={filter} signedOut={!!signIn} />
          )
        ) : (
          <ul className="space-y-1">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  ref={c.id === activeComment ? activeRow : undefined}
                  type="button"
                  onClick={() => onPick(c.id)}
                  aria-current={c.id === activeComment ? "true" : undefined}
                  className={LIST_ROW}
                >
                  <span className="flex items-center gap-2">
                    <PersonAvatar who={c.author} />
                    <span className="min-w-0 truncate text-xs font-semibold">
                      {principalLabel(c.author)}
                    </span>
                    {c.created_at ? (
                      <span className="shrink-0 text-[11px] text-[var(--color-fg-muted)]">
                        <RelativeTime iso={c.created_at} />
                      </span>
                    ) : null}
                    {c.status === COMMENT_STATUS.resolved ? (
                      <span className="ml-auto shrink-0 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        Resolved
                      </span>
                    ) : null}
                  </span>
                  <span className="ml-7 block">
                    <Quote text={anchorLabel(c)} />
                    <span className="mt-1 block">
                      <CommentBody text={c.body} mentions={c.mentions} preview />
                    </span>
                    {lost(c) ? (
                      <Badge variant="warning" className="mt-1">
                        Not found in this version
                      </Badge>
                    ) : null}
                    {c.replies?.length ? (
                      <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">
                        {c.replies.length}{" "}
                        {c.replies.length === 1 ? "reply" : "replies"}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CommentsEmptyState({
  filter,
  signedOut,
}: {
  filter: ListFilter;
  signedOut: boolean;
}) {
  const titles: Record<ListFilter, string> = {
    all: "No comments yet",
    open: "No open comments",
    resolved: "No resolved comments yet",
    "for you": "No comments mention you",
  };
  return (
    <EmptyState
      icon={<MessageSquareText className="h-5 w-5" />}
      title={titles[filter]}
      description={
        filter === COMMENT_STATUS.resolved
          ? "Resolved conversations will appear here."
          : signedOut
            ? "Sign in to start a thread."
            : "Select text, or press C and click a spot, to start a thread."
      }
    />
  );
}
