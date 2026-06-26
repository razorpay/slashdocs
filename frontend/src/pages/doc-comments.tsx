import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { CheckCircle2, Trash2 } from "lucide-react";
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
import { api, type Anchor, type Comment, type Principal } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import {
  COMMENT_FILTERS,
  COMMENT_FILTER_ALL,
  COMMENT_STATUS,
  DEFAULT_COMMENT_FILTER,
  PLACEMENT_STATUS,
  type CommentFilter,
} from "@/lib/constants";
import { useDoc } from "./doc-context";

export function Comments() {
  const {
    docId,
    version,
    comments,
    commentsLoading,
    commentsError,
    selection,
    setSelection,
  } = useDoc();
  const q = useQueryClient();
  const [filter, setFilter] = useState<CommentFilter>(DEFAULT_COMMENT_FILTER);
  const [quote, setQuote] = useState("");
  const [body, setBody] = useState("");
  const anchorRef = useRef<Partial<Anchor> | undefined>(undefined);

  useEffect(() => {
    if (selection?.quote) {
      setQuote(selection.quote);
      anchorRef.current = selection.anchor;
    }
  }, [selection]);

  const create = useMutation({
    mutationFn: () => api.createComment(docId, version, body, quote, anchorRef.current),
    onSuccess: () => {
      setBody("");
      setQuote("");
      anchorRef.current = undefined;
      setSelection(null);
      toast.success("Comment added.");
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not add comment")),
  });

  const clear = () => {
    setQuote("");
    setBody("");
    anchorRef.current = undefined;
    setSelection(null);
  };

  const items = comments.filter((c) => {
    if (filter === COMMENT_FILTER_ALL) return true;
    if (filter === COMMENT_STATUS.resolved) return c.status === COMMENT_STATUS.resolved;
    return c.status !== COMMENT_STATUS.resolved;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Comments</h2>
          <Badge variant="muted">{comments.length}</Badge>
        </div>
        <div className="flex gap-1 rounded-md bg-[var(--color-surface-muted)] p-0.5 text-xs">
          {COMMENT_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 rounded px-2 py-1 capitalize transition-colors ${filter === f ? "bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm" : "text-[var(--color-fg-muted)]"}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {quote && (
          <form
            className="mb-4 space-y-2 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="border-l-2 border-[var(--color-accent)] pl-2 text-xs italic text-[var(--color-fg-muted)]">
              “{quote.length > 80 ? quote.slice(0, 80) + "…" : quote}”
            </div>
            <Textarea
              autoFocus
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (body.trim() && !create.isPending) create.mutate();
                }
              }}
              placeholder="Add a comment…"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={clear}>
                Cancel
              </Button>
              <Button size="sm" type="submit" disabled={!body || create.isPending}>
                Comment ⌘↵
              </Button>
            </div>
          </form>
        )}
        {commentsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : commentsError ? (
          <Center>Could not load comments.</Center>
        ) : items.length === 0 ? (
          <EmptyState
            title={filter === COMMENT_STATUS.open ? "No open comments" : "Nothing here"}
            description="Select text inside the rendered document to start a thread."
          />
        ) : (
          <div className="space-y-3">
            {items.map((c) => (
              <CommentCard key={c.id} c={c} docId={docId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({ c, docId }: { c: Comment; docId: string }) {
  const q = useQueryClient();
  const { activeComment, commentNavigation, navigateToComment, principal } = useDoc();
  const cardRef = useRef<HTMLElement>(null);
  const active = activeComment === c.id;
  const documentNavigationSeq =
    commentNavigation?.id === c.id && commentNavigation.source === "document"
      ? commentNavigation.seq
      : undefined;
  useEffect(() => {
    if (!active || !documentNavigationSeq) return;
    cardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, documentNavigationSeq]);
  const reply = useMutation({
    mutationFn: (body: string) => api.createCommentReply(docId, c.id, body),
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    onError: (e) => toast.error(errorMessage(e, "Could not add reply")),
  });
  const m = useMutation({
    mutationFn: (status: string) => api.patchComment(docId, c.id, c.body, status),
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    onError: (e) => toast.error(errorMessage(e, "Could not update comment")),
  });
  const resolved = c.status === COMMENT_STATUS.resolved;
  return (
    <article
      ref={cardRef}
      className={`group cursor-pointer rounded-[12px] border bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border-strong)] ${active ? "border-[var(--color-border-strong)] ring-1 ring-[var(--color-border-strong)]" : "border-[var(--color-border)]"} ${resolved ? "opacity-70" : ""}`}
      onClick={() => navigateToComment(c.id)}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold">
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
      {c.current_placement?.status &&
        c.current_placement.status !== PLACEMENT_STATUS.attached && (
          <Badge variant="warning" className="mb-2">
            {c.current_placement.status}
          </Badge>
        )}
      {c.selected_text && (
        <blockquote className="mb-2 border-l-2 border-[var(--color-border-strong)] pl-2 text-xs italic text-[var(--color-fg-muted)]">
          {c.selected_text}
        </blockquote>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">{c.body}</p>
        <DeleteCommentButton
          c={c}
          docId={docId}
          canDelete={samePrincipal(principal, c.author)}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
      {(c.replies || []).length > 0 && (
        <div className="mt-3 space-y-2 border-l border-[var(--color-border)] pl-3">
          {(c.replies || []).map((r) => (
            <ReplyItem
              key={r.id}
              r={r}
              docId={docId}
              canDelete={samePrincipal(principal, r.author)}
            />
          ))}
        </div>
      )}
      <ReplyComposer onReply={(body) => reply.mutate(body)} pending={reply.isPending} />
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            m.mutate(resolved ? COMMENT_STATUS.open : COMMENT_STATUS.resolved);
          }}
        >
          {resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
    </article>
  );
}

function ReplyItem({
  r,
  docId,
  canDelete,
}: {
  r: Comment;
  docId: string;
  canDelete: boolean;
}) {
  return (
    <div className="group/reply rounded-md bg-[var(--color-surface-muted)]/50 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">
          {r.author.name || r.author.email || r.author.id}
        </span>
        <DeleteCommentButton
          c={r}
          docId={docId}
          canDelete={canDelete}
          className="opacity-0 transition-opacity group-hover/reply:opacity-100"
        />
      </div>
      <p className="text-sm">{r.body}</p>
    </div>
  );
}

function ReplyComposer({
  onReply,
  pending,
}: {
  onReply: (body: string) => void;
  pending: boolean;
}) {
  const [body, setBody] = useState("");
  return (
    <form
      className="mt-3 flex gap-2"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim() || pending) return;
        onReply(body.trim());
        setBody("");
      }}
    >
      <Textarea
        rows={1}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Reply…"
        className="min-h-9 text-sm"
      />
      <Button size="sm" type="submit" disabled={!body.trim() || pending}>
        Reply
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
          className={`h-7 w-7 shrink-0 ${className}`}
          aria-label="Delete comment"
          onClick={(e) => e.stopPropagation()}
        >
          <Trash2 className="h-3.5 w-3.5" />
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

function samePrincipal(a: Principal | undefined, b: Principal) {
  return !!a && a.type === b.type && a.id === b.id;
}
