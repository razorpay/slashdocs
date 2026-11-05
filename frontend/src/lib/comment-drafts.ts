import { useCallback, useEffect, useRef, useState } from "react";
import type { Anchor, CommentMention } from "@/api";
import type { MentionDraft } from "./comment-mentions";
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

// unsentText is what stays in a field after the text `sent` posts: the words
// typed after it while it was sent. If the reader changed the sent words, all
// of the field stays, so that nothing they typed goes.
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

// useDraftText keeps the text of a field that is saved as a draft. What is
// typed goes to save after a short pause, and at once when the field closes.
// As with setState, edit also takes a function of the text now, and it gives
// back the new text.
export function useDraftText(
  initial: MentionDraft,
  save: (text: MentionDraft) => void,
) {
  const [text, setText] = useState(initial);
  const latest = useRef(initial);
  const unsaved = useRef<MentionDraft | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latestSave = useRef(save);
  latestSave.current = save;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (unsaved.current) latestSave.current(unsaved.current);
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
  useEffect(() => flush, [flush]);
  return [text, edit] as const;
}
