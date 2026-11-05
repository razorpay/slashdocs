import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Anchor, Comment, CommentMention } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "./comment-mentions";
import { createPersistentStore } from "./persistent-store";

// An unsent comment. It keeps the version it was written against, so it can
// still post after the document changes, even when its text is gone.
export type CommentDraft = {
  id: string;
  version: string;
  // Empty for a point comment on an element without text.
  quote: string;
  anchor?: Partial<Anchor>;
  body: string;
  mentions: CommentMention[];
  updatedAt: number;
};

// An unsent reply to a thread.
type ReplyDraft = MentionDraft & { updatedAt: number };

// A comment that a reader who is signed out started on a selection. It waits
// while they sign in, and then opens as a draft.
export type PendingComment = {
  docId: string;
  version: string;
  selection: Pick<CommentDraft, "quote" | "anchor">;
};

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const EMPTY: CommentDraft[] = [];
const fresh = (updatedAt: number) => updatedAt > Date.now() - MAX_AGE;

type DraftsByDocument = Record<string, CommentDraft[]>;
type RepliesByDocument = Record<string, Record<string, ReplyDraft>>;

const store = createPersistentStore<DraftsByDocument>(
  "slashdocs.comment-drafts",
  {},
  (parsed) => {
    const out: DraftsByDocument = {};
    for (const [docId, drafts] of Object.entries(parsed as DraftsByDocument)) {
      const kept = Array.isArray(drafts)
        ? drafts.filter(
            (d) => d?.id && (d.quote || d.anchor?.point) && fresh(d.updatedAt),
          )
        : [];
      if (kept.length) out[docId] = kept;
    }
    return out;
  },
);

const replies = createPersistentStore<RepliesByDocument>(
  "slashdocs.reply-drafts",
  {},
  (parsed) => {
    const out: RepliesByDocument = {};
    for (const [docId, threads] of Object.entries(parsed as RepliesByDocument)) {
      const kept = Object.entries(threads ?? {}).filter(
        ([, d]) => d?.body?.trim() && Array.isArray(d.mentions) && fresh(d.updatedAt),
      );
      if (kept.length) out[docId] = Object.fromEntries(kept);
    }
    return out;
  },
);

const pending = createPersistentStore<PendingComment | null>(
  "slashdocs.pending-comment",
  null,
);

// Unsent comments must not outlive the session on a shared browser.
export function clearCommentDrafts() {
  store.write({});
  replies.write({});
  pending.write(null);
}

// useCommentDrafts reads and updates one document's drafts. Every open tab
// sees the same drafts.
export function useCommentDrafts(docId: string) {
  const drafts = store.useStore()[docId] ?? EMPTY;
  const update = useCallback(
    (change: (drafts: CommentDraft[]) => CommentDraft[]) => {
      const all = { ...store.read() };
      const next = change(all[docId] ?? EMPTY);
      if (next.length) all[docId] = next;
      else delete all[docId];
      store.write(all);
    },
    [docId],
  );
  return [drafts, update] as const;
}

// saveReplyDraft keeps the unsent reply to one thread. A reply with no text
// is no draft.
export function saveReplyDraft(
  docId: string,
  threadId: string,
  { body, mentions }: MentionDraft,
) {
  const all = { ...replies.read() };
  const threads = { ...all[docId] };
  if (body.trim()) threads[threadId] = { body, mentions, updatedAt: Date.now() };
  else delete threads[threadId];
  if (Object.keys(threads).length) all[docId] = threads;
  else delete all[docId];
  replies.write(all);
}

// useReplyDraft reads and updates the unsent reply to one thread.
export function useReplyDraft(docId: string, threadId: string) {
  const draft = replies.useStore()[docId]?.[threadId];
  const update = useCallback(
    (text: MentionDraft) => saveReplyDraft(docId, threadId, text),
    [docId, threadId],
  );
  return [draft, update] as const;
}

// The messages being edited, by comment id: the thread of each, the text
// that its edit started from, and the words in its field. A thread's own menu
// sits in its header, apart from the message it edits, so the edits live out
// of the field. Thus the words also outlive a message that someone deletes
// during its edit. They stay in this tab only.
export type Edit = { thread: string; base: string; text: MentionDraft };
let edits: ReadonlyMap<string, Edit> = new Map();
const editListeners = new Set<() => void>();
export function setEdit(id: string, edit?: Edit) {
  const next = new Map(edits);
  if (edit) next.set(id, edit);
  else next.delete(id);
  edits = next;
  editListeners.forEach((listener) => listener());
}
function subscribeEdits(listener: () => void) {
  editListeners.add(listener);
  return () => editListeners.delete(listener);
}
export const readEdit = (id: string) => edits.get(id);
export const useEdits = () => useSyncExternalStore(subscribeEdits, () => edits);
export const useEdit = (id: string) =>
  useSyncExternalStore(subscribeEdits, () => edits.get(id));

// lostEdits are the edits in a thread whose words the reader changed, of the
// messages that it no longer holds.
export function lostEdits(
  all: ReadonlyMap<string, Edit>,
  thread: string,
  kept: string[],
) {
  return [...all].filter(
    ([id, edit]) =>
      edit.thread === thread && !kept.includes(id) && edit.text.body !== edit.base,
  );
}

// forgetWords drops what the reader did not send in a message or a thread:
// its edits, and the reply to a thread.
export function forgetWords(
  docId: string,
  c: Pick<Comment, "id" | "parent_comment_id">,
) {
  edits.forEach((edit, id) => {
    if (id === c.id || edit.thread === c.id) setEdit(id);
  });
  if (!c.parent_comment_id) saveReplyDraft(docId, c.id, emptyMentionDraft());
}

// useLostWords gives what the reader did not send in a thread, for when it is
// gone: the words of its edits, and the reply to it.
export function useLostWords(docId: string, threadId = ""): MentionDraft[] {
  const [reply] = useReplyDraft(docId, threadId);
  const texts = lostEdits(useEdits(), threadId, []).map(([, edit]) => edit.text);
  return reply ? [...texts, reply] : texts;
}

export function keepPendingComment(comment: PendingComment) {
  pending.write(comment);
}

// takePendingComment gives the comment that waits for a document, once.
export function takePendingComment(docId: string): PendingComment | null {
  const comment = pending.read();
  pending.write(null);
  return comment?.docId === docId ? comment : null;
}

// Typing stays in local state and reaches storage after a short pause, so a
// keystroke does not re-render the whole page.
const SAVE_DELAY = 300;

// unsentText is what stays in a field when the text `sent` posts from it: the
// words after the sent ones. If the field does not start with the sent words,
// all of it stays, so that nothing the reader typed goes.
export function unsentText(now: MentionDraft, sent: MentionDraft): MentionDraft {
  if (!now.body.startsWith(sent.body)) return now;
  const start = now.body.length - now.body.slice(sent.body.length).trimStart().length;
  return {
    body: now.body.slice(start),
    mentions: now.mentions
      .filter((m) => m.offset >= start)
      .map((m) => ({ ...m, offset: m.offset - start })),
  };
}

// sentBack is the text of a field after the text `sent` failed to post: the
// sent words again, before the words typed since.
export function sentBack(sent: MentionDraft, now: MentionDraft): MentionDraft {
  if (!now.body.trim()) return sent;
  const start = sent.body.length + 1;
  return {
    body: `${sent.body} ${now.body}`,
    mentions: [
      ...sent.mentions,
      ...now.mentions.map((m) => ({ ...m, offset: m.offset + start })),
    ],
  };
}

const sameText = (a: MentionDraft, b: MentionDraft) =>
  a.body === b.body || (!a.body.trim() && !b.body.trim());

// useDraftText keeps the text of a field that is saved as a draft in `stored`.
// What is typed goes to save after a short pause, and at once when the field
// closes. As with setState, edit also takes a function of the text now, and
// it gives back the new text.
//
// Another tab can change the stored draft. If the field has no unsaved words,
// it takes the new text. If it has, it keeps the reader's words and gives the
// conflict: the other text, and the choice between them. Until the reader
// chooses, nothing is saved, so that this tab does not replace the newer text.
export function useDraftText(stored: MentionDraft, save: (text: MentionDraft) => void) {
  const [text, setText] = useState(stored);
  const [theirs, setTheirs] = useState<MentionDraft>();
  const latest = useRef(stored);
  // The stored text that the field last agreed with.
  const base = useRef(stored);
  const unsaved = useRef<MentionDraft | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useRef(save);
  latestSave.current = save;
  const held = useRef(false);
  held.current = !!theirs;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (unsaved.current && !held.current) {
      base.current = unsaved.current;
      latestSave.current(unsaved.current);
    }
    unsaved.current = null;
  }, []);
  const edit = useCallback(
    (next: MentionDraft | ((now: MentionDraft) => MentionDraft)) => {
      const value = typeof next === "function" ? next(latest.current) : next;
      latest.current = unsaved.current = value;
      setText(value);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY);
      return value;
    },
    [flush],
  );
  // The field shows `next` as what is stored, with nothing to save.
  const take = useCallback((next: MentionDraft) => {
    window.clearTimeout(timer.current);
    latest.current = next;
    unsaved.current = null;
    setText(next);
    setTheirs(undefined);
  }, []);
  const incoming = useRef(stored);
  incoming.current = stored;
  useEffect(() => {
    const next = incoming.current;
    if (sameText(next, base.current)) return;
    const mine = latest.current;
    const untouched = sameText(mine, base.current) || sameText(mine, next);
    base.current = next;
    if (untouched) take(next);
    else setTheirs(next);
  }, [stored.body, take]);
  useEffect(() => flush, [flush]);
  const conflict = theirs && {
    theirs,
    take: () => take(theirs),
    keep: () => {
      held.current = false;
      setTheirs(undefined);
      unsaved.current = latest.current;
      flush();
    },
  };
  return [text, edit, conflict] as const;
}

export type DraftConflict = NonNullable<ReturnType<typeof useDraftText>[2]>;
