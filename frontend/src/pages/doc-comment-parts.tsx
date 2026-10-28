import {
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, type Comment, type Principal } from "@/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { principalColor, principalLabel, samePrincipal } from "@/lib/principals";
import { COMMENT_STATUS } from "@/lib/constants";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMe } from "@/lib/hooks";
import { useDoc } from "./doc-context";
import { CommentBody, MentionTextarea } from "./doc-comments";
import { ReactionBar } from "./doc-comment-reactions";

// The parts of a comment thread, shared by the comments panel and the thread
// beside a canvas pin. The structure follows Figma (each message as avatar,
// name and time on one line with its text beneath; replies split by hairlines;
// a reply field that is always there), in slashdocs' own look.

// PersonAvatar is a person's photo, or their initials on their own color: the
// color of their pins and their live cursor, so one person reads as one
// color everywhere on the canvas.
export function PersonAvatar({ who, size = 20 }: { who: Principal; size?: number }) {
  const name = principalLabel(who);
  if (who.picture_url) return <Avatar size={size} name={name} src={who.picture_url} />;
  const initials =
    name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.45)),
        background: principalColor(who),
      }}
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white [text-box:trim-both_cap_alphabetic]"
    >
      {initials}
    </span>
  );
}

const muted = "text-[var(--color-fg-muted)]";

function copyLink(commentId: string) {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("comment", commentId);
  void navigator.clipboard.writeText(url.toString()).then(
    () => toast.success("Comment link copied."),
    () => toast.error("Could not copy the comment link."),
  );
}

// The messages being edited. A thread's own menu sits in its header, apart
// from the message it edits, so the state is shared by comment id.
const editing = new Set<string>();
const editListeners = new Set<() => void>();
function setEditing(id: string, on: boolean) {
  if (on) editing.add(id);
  else editing.delete(id);
  editListeners.forEach((listener) => listener());
}
function subscribeEditing(listener: () => void) {
  editListeners.add(listener);
  return () => editListeners.delete(listener);
}
function useEditing(id: string) {
  return useSyncExternalStore(subscribeEditing, () => editing.has(id));
}

// MoreMenu holds the rarer actions of a thread or a message.
export function MoreMenu({
  c,
  docId,
  thread,
  className,
}: {
  c: Comment;
  docId: string;
  thread: boolean;
  className?: string;
}) {
  const q = useQueryClient();
  const { principal } = useDoc();
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteComment(docId, c.id),
    onSuccess: () => {
      toast.success("Deleted.");
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not delete comment")),
  });
  const mine = samePrincipal(principal, c.author);
  return (
    <>
      <Dropdown>
        <DropdownTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={thread ? "More actions" : "Message actions"}
            className={cn("h-8 w-8 shrink-0", muted, className)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownTrigger>
        <DropdownContent className="min-w-[180px]">
          <DropdownItem onSelect={() => copyLink(c.id)}>
            <Link2 className="h-4 w-4" /> Copy link
          </DropdownItem>
          {mine ? (
            <DropdownItem onSelect={() => setEditing(c.id, true)}>
              <Pencil className="h-4 w-4" /> Edit
            </DropdownItem>
          ) : null}
          {mine ? (
            <DropdownItem
              onSelect={() => setConfirming(true)}
              className="text-rose-600 dark:text-rose-400"
            >
              <Trash2 className="h-4 w-4" /> {thread ? "Delete thread" : "Delete reply"}
            </DropdownItem>
          ) : null}
        </DropdownContent>
      </Dropdown>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {thread ? "Delete thread?" : "Delete reply?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {thread
              ? "This removes the comment and all its replies permanently."
              : "This removes the reply permanently."}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={() => del.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function Message({
  c,
  docId,
  thread,
  actions,
}: {
  c: Comment;
  docId: string;
  thread: boolean;
  // actions sit at the end of the root message's line, as in the panel.
  actions?: React.ReactNode;
}) {
  return (
    <div data-comment-id={c.id} className="group/msg">
      <div className="flex min-h-6 items-center gap-2">
        <PersonAvatar who={c.author} size={thread ? 20 : 18} />
        <span className="min-w-0 truncate text-xs font-semibold">
          {principalLabel(c.author)}
        </span>
        {c.created_at ? (
          <span className={cn("shrink-0 text-[11px]", muted)}>
            <RelativeTime iso={c.created_at} />
          </span>
        ) : null}
        {/* The thread's own actions sit in its header; a reply's on hover. */}
        {actions}
        {!thread ? (
          <MoreMenu
            c={c}
            docId={docId}
            thread={false}
            className="-my-1 ml-auto h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover/msg:opacity-100 data-[state=open]:opacity-100"
          />
        ) : null}
      </div>
      <div className="mt-0.5 pl-7">
        {thread && c.selected_text ? (
          <blockquote className="mb-2 rounded-r-md border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] py-1.5 pl-2 pr-2 text-xs leading-relaxed break-words text-[var(--color-fg-muted)]">
            {c.selected_text}
          </blockquote>
        ) : null}
        <EditableBody c={c} docId={docId} />
        {c.reactions?.length ? (
          <div className="mt-1">
            <ReactionBar c={c} docId={docId} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// EditableBody is a message's text, or, while its author edits it, a field
// with the text to change. Enter saves, Shift+Enter starts a new line, Esc
// cancels.
function EditableBody({ c, docId }: { c: Comment; docId: string }) {
  const q = useQueryClient();
  const isEditing = useEditing(c.id);
  const [draft, setDraft] = useState<MentionDraft>({
    body: c.body,
    mentions: c.mentions || [],
  });
  const save = useMutation({
    mutationFn: () => api.patchComment(docId, c.id, draft),
    onSuccess: async () => {
      await q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      setEditing(c.id, false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update comment")),
  });
  if (!isEditing)
    return (
      <>
        <CommentBody text={c.body} mentions={c.mentions} />
        {c.edited ? <div className={cn("text-[11px]", muted)}>edited</div> : null}
      </>
    );
  const ready = !!draft.body.trim() && !save.isPending;
  const cancel = () => {
    setDraft({ body: c.body, mentions: c.mentions || [] });
    setEditing(c.id, false);
  };
  return (
    <form
      className="flex min-w-0 items-end gap-1"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <MentionTextarea
        rows={1}
        autoFocus
        draft={draft}
        onChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (ready) save.mutate();
        }}
        className="block max-h-40 min-h-9 resize-none py-1.5 text-sm [field-sizing:content]"
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Cancel edit"
        title="Cancel edit (Esc)"
        disabled={save.isPending}
        onClick={cancel}
        className={cn("shrink-0", muted)}
      >
        <X className="h-4 w-4" />
      </Button>
      <Button
        type="submit"
        size="icon"
        aria-label="Save comment"
        title="Save comment (Enter)"
        aria-keyshortcuts="Enter"
        disabled={!ready}
        className="shrink-0"
      >
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

// ComposeField is the field for a reply or a new pin's comment: one line that
// grows with the text, and a send button. Enter sends, Shift+Enter starts a
// new line.
export function ComposeField({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  autoFocus,
  sendLabel,
}: {
  value: MentionDraft;
  onChange: (next: MentionDraft) => void;
  onSubmit: () => void;
  pending: boolean;
  placeholder: string;
  autoFocus?: boolean;
  sendLabel: string;
}) {
  const ready = !!value.body.trim() && !pending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSubmit();
  };
  // Enter sends; Shift+Enter (or Alt+Enter) starts a new line.
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (ready) onSubmit();
  };
  return (
    <form className="flex min-w-0 flex-1 items-end gap-2" onSubmit={submit}>
      <MentionTextarea
        rows={1}
        autoFocus={autoFocus}
        draft={value}
        onChange={onChange}
        placeholder={placeholder}
        onKeyDown={sendOnEnter}
        className="block max-h-40 min-h-9 resize-none py-1.5 text-sm [field-sizing:content]"
      />
      <Button
        size="icon"
        type="submit"
        aria-label={sendLabel}
        title={`${sendLabel} (Enter)`}
        aria-keyshortcuts="Enter"
        disabled={!ready}
        className="shrink-0"
      >
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

export function ReplyRow({
  c,
  docId,
  className,
  autoFocus,
}: {
  c: Comment;
  docId: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const q = useQueryClient();
  const { signIn } = useDoc();
  const self = useSelf();
  const [draft, setDraft] = useState<MentionDraft>(emptyMentionDraft);
  const sent = useRef<MentionDraft | null>(null);
  const reply = useMutation({
    mutationFn: (d: MentionDraft) =>
      api.createCommentReply(docId, c.id, d.body, d.mentions),
    onSuccess: () => {
      // Keep anything typed after sending.
      setDraft((current) => (current === sent.current ? emptyMentionDraft() : current));
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not add reply")),
  });
  const send = () => {
    sent.current = draft;
    reply.mutate(draft);
  };
  if (signIn) return null;
  return (
    <div
      className={cn(
        "flex items-end gap-2 border-t border-[var(--color-border)] px-3 py-2.5",
        className,
      )}
    >
      {self ? (
        <span className="pb-[9px]">
          <PersonAvatar who={self} size={18} />
        </span>
      ) : null}
      <ComposeField
        value={draft}
        onChange={setDraft}
        pending={reply.isPending}
        placeholder="Reply…"
        sendLabel="Post reply"
        autoFocus={autoFocus}
        onSubmit={send}
      />
    </div>
  );
}

// ResolveButton resolves a thread, or reopens a resolved one.
export function ResolveButton({
  c,
  docId,
  className,
}: {
  c: Comment;
  docId: string;
  className?: string;
}) {
  const q = useQueryClient();
  const { signIn } = useDoc();
  const resolved = c.status === COMMENT_STATUS.resolved;
  const status = useMutation({
    mutationFn: (next: string) => api.patchComment(docId, c.id, { status: next }),
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    onError: (e) => toast.error(errorMessage(e, "Could not update comment")),
  });
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (signIn) return signIn();
    status.mutate(resolved ? COMMENT_STATUS.open : COMMENT_STATUS.resolved);
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={resolved ? "Reopen comment" : "Resolve comment"}
      disabled={status.isPending}
      onClick={toggle}
      className={cn(
        "h-8 w-8 shrink-0",
        resolved
          ? muted
          : "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40",
        className,
      )}
    >
      {resolved ? (
        <RotateCcw className="h-4 w-4" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
    </Button>
  );
}

// Replies are the thread's replies, set in under the first comment: a small
// "N replies" label with a rule, then each reply indented to the first
// comment's text, so the one parent and its replies read at a glance.
export function Replies({ c, docId }: { c: Comment; docId: string }) {
  const replies = c.replies || [];
  if (!replies.length) return null;
  return (
    <div className="ml-7 mt-3">
      <div className={cn("flex items-center gap-2 text-[11px] font-medium", muted)}>
        {replies.length} {replies.length === 1 ? "reply" : "replies"}
        <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      {replies.map((r) => (
        <div key={r.id} className="mt-2.5">
          <Message c={r} docId={docId} thread={false} />
        </div>
      ))}
    </div>
  );
}

// useSelf is the reader as a principal with their name: the session's
// principal may carry only an id, and the profile has the name.
export function useSelf(): Principal | undefined {
  const { principal } = useDoc();
  const me = useMe();
  return (
    principal && {
      ...me.data?.user,
      ...principal,
      name: principal.name || me.data?.user?.name,
    }
  );
}
