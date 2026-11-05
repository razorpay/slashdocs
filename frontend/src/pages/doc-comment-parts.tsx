import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Link2,
  MapPin,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { APIError, api, type Comment, type Principal } from "@/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { principalColor, principalLabel, samePrincipal } from "@/lib/principals";
import { COMMENT_STATUS } from "@/lib/constants";
import { agentThatSaw, isAgentRequest } from "@/lib/agent-request";
import { anchorLabel, canMovePin } from "@/lib/comment-pins";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Badge } from "@/components/ui/badge";
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
import {
  forgetWords,
  lostEdits,
  readEdit,
  sentBack,
  setEdit,
  unsentText,
  useDraftText,
  useEdit,
  useEdits,
  useReplyDraft,
  type DraftConflict,
  type Edit,
} from "@/lib/comment-drafts";
import { useSelf } from "@/lib/hooks";
import { useDoc } from "./doc-context";
import { CommentBody, MentionTextarea } from "./doc-comment-text";
import { ReactionBar } from "./doc-comment-reactions";

// The parts of a comment thread, which the comments panel uses. The structure
// follows Figma (each message as avatar, name and time on one line with its
// text beneath; replies split by hairlines; a reply field that is always
// there), in slashdocs' own look.

// PersonAvatar is a person's photo, or their initials on their principalColor,
// the same color as their live cursor.
export function PersonAvatar({ who, size = 20 }: { who: Principal; size?: number }) {
  return (
    <Avatar
      size={size}
      name={principalLabel(who)}
      src={who.picture_url}
      color={principalColor(who)}
    />
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
  const { principal, editable, setPlacingPin } = useDoc();
  const [confirming, setConfirming] = useState(false);
  // What takes the focus, as the edit field or the document frame, does so
  // after the menu gives back the focus, or the menu takes the focus from it
  // as it closes.
  const afterClose = useRef<() => void>(undefined);
  const del = useMutation({
    mutationFn: () => api.deleteComment(docId, c.id),
    onSuccess: () => {
      forgetWords(docId, c);
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
        <DropdownContent
          className="min-w-[180px]"
          onCloseAutoFocus={(event) => {
            const run = afterClose.current;
            if (!run) return;
            afterClose.current = undefined;
            event.preventDefault();
            run();
          }}
        >
          <DropdownItem onSelect={() => copyLink(c.id)}>
            <Link2 className="h-4 w-4" /> Copy link
          </DropdownItem>
          {thread && canMovePin(c, editable, principal) ? (
            <DropdownItem
              onSelect={() => (afterClose.current = () => setPlacingPin(c.id))}
            >
              <MapPin className="h-4 w-4" /> Move pin
            </DropdownItem>
          ) : null}
          {mine ? (
            <DropdownItem
              onSelect={() =>
                (afterClose.current = () =>
                  setEdit(c.id, {
                    thread: c.parent_comment_id || c.id,
                    base: c.body,
                    text: textOf(c),
                  }))
              }
            >
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
        <AgentRequestBadge c={c} />
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
        {thread && anchorLabel(c) ? (
          <blockquote className="mb-2 rounded-r-md border-l-2 border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] py-1.5 pl-2 pr-2 text-xs leading-relaxed break-words text-[var(--color-fg-muted)]">
            {anchorLabel(c)}
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

// AgentRequestBadge marks a comment that asks an agent to change words, and
// names the bot that saw it.
export function AgentRequestBadge({ c }: { c: Comment }) {
  if (!isAgentRequest(c.body)) return null;
  const agent = agentThatSaw(c);
  return (
    <Badge variant="accent" className="shrink-0">
      Agent request{agent ? ` · Seen by ${principalLabel(agent)}` : ""}
    </Badge>
  );
}

const textOf = (c: Comment): MentionDraft => ({
  body: c.body,
  mentions: c.mentions || [],
});

// EditableBody is a message's text, or, while its author edits it, a field
// with the text to change.
function EditableBody({ c, docId }: { c: Comment; docId: string }) {
  const edit = useEdit(c.id);
  if (edit) return <EditForm c={c} docId={docId} edit={edit} />;
  return (
    <>
      <CommentBody text={c.body} mentions={c.mentions} />
      {c.edited ? <div className={cn("text-[11px]", muted)}>edited</div> : null}
    </>
  );
}

// EditForm changes a message's text, from the text on screen when the edit
// starts. Enter saves, Shift+Enter starts a new line, Esc cancels. If another
// person changes the message during the edit, the field takes their text when
// the reader changed nothing. Else it tells them, so that Save does not replace
// the other change without notice. The server refuses a save from a text that
// the reader did not see, and then the new text shows here as well.
function EditForm({ c, docId, edit }: { c: Comment; docId: string; edit: Edit }) {
  const q = useQueryClient();
  const noun = c.parent_comment_id ? "reply" : "comment";
  const { base, text: draft } = edit;
  const update = (next: Partial<Edit>) => setEdit(c.id, { ...edit, ...next });
  const save = useMutation({
    mutationFn: (sent: MentionDraft) =>
      api.patchComment(docId, c.id, { ...sent, base_body: c.body }),
    onSuccess: async (_, sent) => {
      await q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      const now = readEdit(c.id);
      // Words typed while it saved keep the field open.
      if (now?.text.body === sent.body) setEdit(c.id);
      else if (now) setEdit(c.id, { ...now, base: sent.body });
    },
    onError: (e) => {
      // A change or a delete by someone else shows here once the thread loads.
      if (e instanceof APIError && [404, 409].includes(e.status))
        return q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      toast.error(errorMessage(e, "Could not update comment"));
    },
  });
  const takeLive = () => update({ base: c.body, text: textOf(c) });
  // The reader's own save changes the text too, so the check waits for it.
  const changed = !save.isPending && c.body !== base;
  const untouched = draft.body === base || draft.body === c.body;
  useLayoutEffect(() => {
    if (changed && untouched) takeLive();
  });
  const ready = !!draft.body.trim() && draft.body !== c.body && !save.isPending;
  const cancel = () => setEdit(c.id);
  return (
    <form
      className="min-w-0"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate(draft);
      }}
    >
      <MentionTextarea
        autoFocus
        label={`Edit ${noun}`}
        draft={draft}
        onChange={(text) => update({ text })}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (ready) save.mutate(draft);
        }}
      />
      {changed && !untouched ? (
        <Notice
          say={`This ${noun} changed while you edited. It now says:`}
          texts={[textOf(c)]}
        >
          <NoticeAction onClick={takeLive}>Use the new text</NoticeAction>
        </Notice>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Cancel (Esc)"
          disabled={save.isPending}
          onClick={cancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          title="Save (Enter)"
          aria-keyshortcuts="Enter"
          disabled={!ready}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

// Notice tells of a change that someone made to the words that the reader
// writes, shows the words that it is about, and offers what to do.
function Notice({
  say,
  texts,
  children,
}: {
  say: string;
  texts: MentionDraft[];
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-2 rounded-md bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs",
        muted,
      )}
    >
      {say}
      {texts.map((text, i) => (
        <div key={i} className="mt-1 text-[var(--color-fg)]">
          <CommentBody text={text.body} mentions={text.mentions} preview />
        </div>
      ))}
      <div className="mt-1 flex gap-3">{children}</div>
    </div>
  );
}

function NoticeAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto p-0 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// LostWords keeps the words that the reader did not send in a message that
// someone deleted, to copy.
export function LostWords({
  what,
  texts,
  onDismiss,
}: {
  what: string;
  texts: MentionDraft[];
  onDismiss: () => void;
}) {
  const copy = () =>
    void navigator.clipboard.writeText(texts.map((t) => t.body).join("\n\n")).then(
      () => toast.success("Your text is copied."),
      () => toast.error("Could not copy your text."),
    );
  return (
    <Notice say={`${what} Your words were not sent:`} texts={texts}>
      <NoticeAction onClick={copy}>Copy my text</NoticeAction>
      <NoticeAction onClick={onDismiss}>Dismiss</NoticeAction>
    </Notice>
  );
}

// SendingMessage is a message on its way to the server, faint until it posts.
export function SendingMessage({ text, who }: { text: MentionDraft; who?: Principal }) {
  return (
    <div aria-busy="true" className="animate-[rise_200ms_ease-out] opacity-60">
      <div className="flex min-h-6 items-center gap-2">
        {who ? (
          <>
            <PersonAvatar who={who} size={18} />
            <span className="min-w-0 truncate text-xs font-semibold">
              {principalLabel(who)}
            </span>
          </>
        ) : null}
        <span className={cn("shrink-0 text-[11px]", muted)}>Sending…</span>
      </div>
      <div className={cn(who && "mt-0.5 pl-7")}>
        <CommentBody text={text.body} mentions={text.mentions} />
      </div>
    </div>
  );
}

// ComposeField is the field for a reply or a new pin's comment: one line that
// grows with the text, and a send button. Enter sends, Shift+Enter starts a
// new line. When another tab changed the same draft, it tells, and offers
// both texts.
export function ComposeField({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  autoFocus,
  sendLabel,
  conflict,
}: {
  value: MentionDraft;
  onChange: (next: MentionDraft) => void;
  onSubmit: () => void;
  pending: boolean;
  placeholder: string;
  autoFocus?: boolean;
  sendLabel: string;
  conflict?: DraftConflict;
}) {
  const ready = !!value.body.trim() && !pending;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    onSubmit();
    // The send button turns off while it sends and would drop the focus, so
    // the field keeps it for the next reply.
    e.currentTarget.querySelector("textarea")?.focus();
  };
  // Enter sends; Shift+Enter (or Alt+Enter) starts a new line.
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (ready) onSubmit();
  };
  return (
    <form className="min-w-0 flex-1" onSubmit={submit}>
      <MentionTextarea
        autoFocus={autoFocus}
        draft={value}
        onChange={onChange}
        placeholder={placeholder}
        onKeyDown={sendOnEnter}
        action={
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
        }
      />
      {conflict ? (
        <Notice
          say="This draft changed in another tab. It now says:"
          texts={[conflict.theirs]}
        >
          <NoticeAction onClick={conflict.take}>Use the new text</NoticeAction>
          <NoticeAction onClick={conflict.keep}>Keep mine</NoticeAction>
        </Notice>
      ) : null}
    </form>
  );
}

const replyKey = (docId: string, threadId: string) => [
  "comment-reply",
  docId,
  threadId,
];

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
  const { principal, signIn } = useDoc();
  const self = useSelf(principal);
  // What is typed stays after the thread closes, the page reloads, or the
  // reader goes away, until it is posted or deleted.
  const [saved, save] = useReplyDraft(docId, c.id);
  const [draft, edit, conflict] = useDraftText(saved ?? emptyMentionDraft(), save);
  const reply = useMutation({
    mutationKey: replyKey(docId, c.id),
    mutationFn: (d: MentionDraft) =>
      api.createCommentReply(docId, c.id, d.body, d.mentions),
    // The reply shows as sending until the thread loads with it.
    onSuccess: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
    // The words go back in the field, and the toast sends them again.
    onError: (e, d) => {
      edit((now) => sentBack(d, now));
      toast.error(errorMessage(e, "Could not add reply"), {
        id: c.id,
        action: { label: "Retry", onClick: () => send(d) },
      });
    },
  });
  // The words leave the field at once, and show in the thread as sending.
  // A new send makes the Retry of an earlier one go, so it cannot post twice.
  const send = (d = draft) => {
    toast.dismiss(c.id);
    edit((now) => unsentText(now, d));
    reply.mutate(d);
  };
  if (signIn) return null;
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-t border-[var(--color-border)] px-3 py-2.5",
        className,
      )}
    >
      {self ? (
        <span className="pt-[9px]">
          <PersonAvatar who={self} size={18} />
        </span>
      ) : null}
      <ComposeField
        value={draft}
        onChange={edit}
        pending={reply.isPending}
        placeholder="Reply…"
        sendLabel="Post reply"
        autoFocus={autoFocus}
        onSubmit={send}
        conflict={conflict}
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
// comment's text, so the one parent and its replies read at a glance. After
// them come the edits of replies that someone deleted, and the replies that
// are on their way.
export function Replies({ c, docId }: { c: Comment; docId: string }) {
  const { principal } = useDoc();
  const self = useSelf(principal);
  const replies = c.replies || [];
  const lost = lostEdits(useEdits(), c.id, [c.id, ...replies.map((r) => r.id)]);
  const sending = useMutationState({
    filters: { mutationKey: replyKey(docId, c.id), status: "pending" },
    select: (mutation) => mutation.state.variables as MentionDraft,
  });
  if (!replies.length && !lost.length && !sending.length) return null;
  return (
    <div className="ml-7 mt-3">
      {replies.length ? (
        <div className={cn("flex items-center gap-2 text-[11px] font-medium", muted)}>
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
          <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
        </div>
      ) : null}
      {replies.map((r) => (
        <div key={r.id} className="mt-2.5">
          <Message c={r} docId={docId} thread={false} />
        </div>
      ))}
      {lost.map(([id, edit]) => (
        <LostWords
          key={id}
          what="This reply was deleted."
          texts={[edit.text]}
          onDismiss={() => setEdit(id)}
        />
      ))}
      {sending.map((text, i) => (
        <div key={i} className="mt-2.5">
          <SendingMessage text={text} who={self} />
        </div>
      ))}
    </div>
  );
}
