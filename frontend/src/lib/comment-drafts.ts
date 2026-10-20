import { useCallback } from "react";
import type { Anchor, CommentMention } from "@/api";
import { createPersistentStore } from "./persistent-store";

// An unsent comment. It keeps the version it was written against, so it can
// still post after the document changes, even when its text is gone.
export type CommentDraft = {
  id: string;
  version: string;
  // Empty for a pin on a canvas, which has anchor.point instead.
  quote: string;
  anchor?: Partial<Anchor>;
  // The canvas's name for a pin's target.
  label?: string;
  // Document offset of the selection, used until the highlight reports its
  // own position.
  top?: number;
  body: string;
  mentions: CommentMention[];
  updatedAt: number;
};

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const EMPTY: CommentDraft[] = [];

type DraftsByDocument = Record<string, CommentDraft[]>;

const store = createPersistentStore<DraftsByDocument>(
  "slashdocs.comment-drafts",
  {},
  (parsed) => {
    const oldest = Date.now() - MAX_AGE;
    const out: DraftsByDocument = {};
    for (const [docId, drafts] of Object.entries(parsed as DraftsByDocument)) {
      const fresh = Array.isArray(drafts)
        ? drafts.filter(
            (d) => d?.id && (d.quote || d.anchor?.point) && d.updatedAt > oldest,
          )
        : [];
      if (fresh.length) out[docId] = fresh;
    }
    return out;
  },
);

export function clearCommentDrafts() {
  store.write({});
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
