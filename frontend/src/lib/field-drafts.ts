import { useCallback } from "react";
import { useDraftText } from "./comment-drafts";
import { createPersistentStore } from "./persistent-store";

// The unsent words of a form field that is not a comment: a reject reason,
// an address to share with, a bot or key name, a title, a folder name. Each
// lives under a key that names its place, such as `reject:<docId>`, so that
// the words come back when the reader opens that form again, after Esc, a
// close, a new version, a route change or a reload. `about` keeps what the
// words were written for, such as the version that a reason describes.
// Sending or discarding the words removes them.
export type FieldDraft = { body: string; about?: string; updatedAt: number };

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const store = createPersistentStore<Record<string, FieldDraft>>(
  "slashdocs.field-drafts.v1",
  {},
  (parsed) =>
    Object.fromEntries(
      Object.entries(parsed as Record<string, FieldDraft>).filter(
        ([, d]) =>
          typeof d?.body === "string" &&
          d.body.trim() !== "" &&
          d.updatedAt > Date.now() - MAX_AGE,
      ),
    ),
);

export const readFieldDraft = (key: string): FieldDraft | undefined =>
  store.read()[key];

export function saveFieldDraft(key: string, body: string, about?: string) {
  const all = { ...store.read() };
  if (body.trim()) all[key] = { body, about, updatedAt: Date.now() };
  else if (all[key]) delete all[key];
  else return;
  try {
    store.write(all);
  } catch {
    // Storage can be blocked or full. The words then stay only on screen.
  }
}

// Unsent words must not outlive the session on a shared browser.
export function clearFieldDrafts() {
  store.write({});
}

const NO_MENTIONS: never[] = [];

// useFieldDraft is the text of one field, kept as the draft under `key`. It
// saves as the comment drafts do (useDraftText): after a short pause, and at
// once when the field goes. If another tab changes the same draft while this
// one holds unsaved words, conflict gives the other text and the choice. Set
// the text to "" to discard it, or to a function of the text now, so that a
// late success clears only the words that it sent:
// `setText((now) => (now === sent ? "" : now))`. Mount the field again
// (a React key) when its key changes.
export function useFieldDraft(key: string, about?: string) {
  const stored = store.useStore()[key];
  const save = useCallback(
    ({ body }: { body: string }) => saveFieldDraft(key, body, about),
    [key, about],
  );
  const [text, edit, conflict] = useDraftText(
    { body: stored?.body ?? "", mentions: NO_MENTIONS },
    save,
  );
  const setText = useCallback(
    (next: string | ((now: string) => string)) =>
      edit((now) => ({
        body: typeof next === "function" ? next(now.body) : next,
        mentions: NO_MENTIONS,
      })).body,
    [edit],
  );
  return { text: text.body, setText, stored, conflict } as const;
}
