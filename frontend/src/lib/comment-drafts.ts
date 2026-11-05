import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Anchor, Comment, CommentMention } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "./comment-mentions";
import { createPersistentStore } from "./persistent-store";

// The words of a draft. When two tabs changed the same draft and a field
// closed before the reader chose, `held` keeps that field's words beside the
// stored ones, until the reader chooses or discards them.
export type DraftText = MentionDraft & { held?: MentionDraft };

// An unsent comment. It keeps the version it was written against, so it can
// still post after the document changes, even when its text is gone.
export type CommentDraft = DraftText & {
  id: string;
  version: string;
  // Empty for a point comment on an element without text.
  quote: string;
  anchor?: Partial<Anchor>;
  mentions: CommentMention[];
  updatedAt: number;
};

// An unsent reply to a thread.
type ReplyDraft = DraftText & { updatedAt: number };

// An unsent edit of a message: its thread, and the text that the edit started
// from. An edit whose words equal its base holds nothing to send.
export type Edit = DraftText & { thread: string; base: string; updatedAt: number };

// A comment that a reader who is signed out started on a selection. It waits
// while they sign in, and then opens as a draft.
export type PendingComment = {
  docId: string;
  version: string;
  selection: Pick<CommentDraft, "quote" | "anchor">;
};

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const EMPTY: CommentDraft[] = [];
const NONE = {};
const fresh = (updatedAt: number) => updatedAt > Date.now() - MAX_AGE;
// hasWords tells whether a draft holds words to keep, in either of its texts.
const hasWords = (d?: DraftText) => !!(d?.body?.trim() || d?.held?.body.trim());

type DraftsByDocument = Record<string, CommentDraft[]>;
type ByDocument<T> = Record<string, Record<string, T>>;

// A store of entries by document and id, such as the replies by thread.
function entriesStore<T extends DraftText & { updatedAt: number }>(
  key: string,
  keep: (entry: T) => boolean,
) {
  const entries = createPersistentStore<ByDocument<T>>(key, {}, (parsed) => {
    const out: ByDocument<T> = {};
    for (const [docId, byId] of Object.entries(parsed as ByDocument<T>)) {
      const kept = Object.entries(byId ?? {}).filter(
        ([, d]) => Array.isArray(d?.mentions) && fresh(d.updatedAt) && keep(d),
      );
      if (kept.length) out[docId] = Object.fromEntries(kept);
    }
    return out;
  });
  // put sets the entry `id` of a document, or removes it.
  const put = (docId: string, id: string, entry?: T) => {
    const all = { ...entries.read() };
    const byId = { ...all[docId] };
    if (entry) byId[id] = entry;
    else delete byId[id];
    if (Object.keys(byId).length) all[docId] = byId;
    else delete all[docId];
    entries.write(all);
  };
  return { ...entries, put };
}

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

const replies = entriesStore<ReplyDraft>("slashdocs.reply-drafts", hasWords);
const edits = entriesStore<Edit>(
  "slashdocs.comment-edits",
  (e) => typeof e.base === "string" && typeof e.body === "string",
);

const pending = createPersistentStore<PendingComment | null>(
  "slashdocs.pending-comment",
  null,
);

// Unsent comments must not outlive the session on a shared browser.
export function clearCommentDrafts() {
  store.write({});
  replies.write({});
  edits.write({});
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
  { body, mentions, held }: DraftText,
) {
  const draft = { body, mentions, held, updatedAt: Date.now() };
  replies.put(docId, threadId, hasWords(draft) ? draft : undefined);
}

// useReplyDraft reads and updates the unsent reply to one thread.
export function useReplyDraft(docId: string, threadId: string) {
  const draft = replies.useStore()[docId]?.[threadId];
  const update = useCallback(
    (text: DraftText) => saveReplyDraft(docId, threadId, text),
    [docId, threadId],
  );
  return [draft, update] as const;
}

// useReplyDrafts gives the unsent replies of a document, by thread.
export const useReplyDrafts = (docId: string): Record<string, ReplyDraft> =>
  replies.useStore()[docId] ?? NONE;

// The messages being edited, by document and comment id. A thread's own menu
// sits in its header, apart from the message it edits, so the edits live out
// of the field. Thus the words also outlive a message that someone deletes
// during its edit, a closed thread and a reload.
export function setEdit(docId: string, id: string, edit?: Omit<Edit, "updatedAt">) {
  edits.put(docId, id, edit && { ...edit, updatedAt: Date.now() });
}
export const readEdit = (docId: string, id: string): Edit | undefined =>
  edits.read()[docId]?.[id];
export const useEdits = (docId: string): Record<string, Edit> =>
  edits.useStore()[docId] ?? NONE;
export const useEdit = (docId: string, id: string) => useEdits(docId)[id];

// changed tells whether an edit holds words that the message does not.
export const changed = (edit: Edit) => edit.body !== edit.base || !!edit.held;

// textsOf gives the words of a draft to show or copy: its own, and those
// that wait beside them.
export const textsOf = ({ body, mentions, held }: DraftText): MentionDraft[] =>
  held ? [{ body, mentions }, held] : [{ body, mentions }];

// copyWords copies the words that the reader did not send.
export function copyWords(texts: MentionDraft[]) {
  void navigator.clipboard.writeText(texts.map((t) => t.body).join("\n\n")).then(
    () => toast.success("Your text is copied."),
    () => toast.error("Could not copy your text."),
  );
}

// lostEdits are the edits in a thread whose words the reader changed, of the
// messages that it no longer holds.
export function lostEdits(all: Record<string, Edit>, thread: string, kept: string[]) {
  return Object.entries(all).filter(
    ([id, edit]) => edit.thread === thread && !kept.includes(id) && changed(edit),
  );
}

// forgetWords drops what the reader did not send in a message or a thread:
// its edits, and the reply to a thread.
export function forgetWords(
  docId: string,
  c: Pick<Comment, "id" | "parent_comment_id">,
) {
  for (const [id, edit] of Object.entries(edits.read()[docId] ?? NONE))
    if (id === c.id || edit.thread === c.id) setEdit(docId, id);
  if (!c.parent_comment_id) saveReplyDraft(docId, c.id, emptyMentionDraft());
}

// useLostWords gives what the reader did not send in a thread, for when it is
// gone: the words of its edits, and the reply to it.
export function useLostWords(docId: string, threadId = ""): MentionDraft[] {
  const [reply] = useReplyDraft(docId, threadId);
  const texts = lostEdits(useEdits(docId), threadId, []).flatMap(([, edit]) =>
    textsOf(edit),
  );
  return reply ? [...texts, ...textsOf(reply)] : texts;
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
const wordsOf = ({ body, mentions }: MentionDraft): MentionDraft => ({
  body,
  mentions,
});

// useDraftText keeps the text of a field that is saved as a draft in `stored`.
// What is typed goes to save after a short pause, and at once when the field
// closes. As with setState, edit also takes a function of the text now, and
// it gives back the new text.
//
// Another tab can change the stored draft. If the field has no unsaved words,
// it takes the new text. If it has, it keeps the reader's words and gives the
// conflict: the other text, and the choice between them. Until the reader
// chooses, the stored text stays, and the reader's words are saved beside it
// as `held`. Thus a field that closes, or a page that reloads, keeps both, and
// the field shows the same conflict when it opens again.
export function useDraftText(stored: DraftText, save: (text: DraftText) => void) {
  const waiting =
    stored.held && !sameText(stored.held, stored) ? stored.held : undefined;
  const [text, setText] = useState(() => waiting ?? wordsOf(stored));
  const [theirs, setTheirs] = useState(() => waiting && wordsOf(stored));
  const latest = useRef(text);
  // The stored text that the field last agreed with.
  const base = useRef(wordsOf(stored));
  const unsaved = useRef<MentionDraft | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useRef(save);
  latestSave.current = save;
  const other = useRef(theirs);
  other.current = theirs;
  const incoming = useRef(stored);
  incoming.current = stored;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const words = unsaved.current;
    unsaved.current = null;
    if (!words) return;
    if (other.current) return latestSave.current({ ...other.current, held: words });
    base.current = words;
    // Words that wait from another field stay until the reader chooses.
    latestSave.current({ ...words, held: incoming.current.held });
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
    other.current = undefined;
    setText(next);
    setTheirs(undefined);
  }, []);
  useEffect(() => {
    const next = wordsOf(incoming.current);
    if (sameText(next, base.current)) return;
    const mine = latest.current;
    const untouched = sameText(mine, base.current) || sameText(mine, next);
    base.current = next;
    if (untouched) take(next);
    else setTheirs(next);
  }, [stored.body, take]);
  useEffect(() => flush, [flush]);
  // The reader's choice ends the conflict, here and in storage.
  const choose = (chosen: MentionDraft) => {
    take(chosen);
    base.current = chosen;
    latestSave.current(chosen);
  };
  const conflict = theirs && {
    theirs,
    take: () => choose(theirs),
    keep: () => choose(latest.current),
  };
  return [text, edit, conflict] as const;
}

export type DraftConflict = NonNullable<ReturnType<typeof useDraftText>[2]>;
