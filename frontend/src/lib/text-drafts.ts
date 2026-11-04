import type { Region, ScriptChange } from "../../bridge/source-pieces";
import { createPersistentStore } from "./persistent-store";

// Text that an editor typed in a document and that did not save: the version
// that the frame loaded, and the edits on top of it. It outlives the page, so
// that the editor can get the text back when they open the document again.
export type TextDraft = {
  version: string;
  edits: { regions: Region[]; scripts: ScriptChange[] };
  updatedAt: number;
};

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// A change to the form of a draft takes a new key.
const store = createPersistentStore<Record<string, TextDraft>>(
  "slashdocs.text-drafts.v1",
  {},
  (parsed) =>
    Object.fromEntries(
      Object.entries(parsed as Record<string, TextDraft>).filter(
        ([, d]) =>
          typeof d?.version === "string" &&
          Array.isArray(d.edits?.regions) &&
          Array.isArray(d.edits?.scripts) &&
          d.updatedAt > Date.now() - MAX_AGE,
      ),
    ),
);

export function readTextDraft(docId: string): TextDraft | undefined {
  return store.read()[docId];
}

export function writeTextDraft(docId: string, draft: Omit<TextDraft, "updatedAt">) {
  try {
    store.write({ ...store.read(), [docId]: { ...draft, updatedAt: Date.now() } });
  } catch {
    // Storage can be blocked or full. The text then stays only on screen.
  }
}

export function removeTextDraft(docId: string) {
  const all = { ...store.read() };
  if (!all[docId]) return;
  delete all[docId];
  store.write(all);
}

// Unsaved text must not outlive the session on a shared browser.
export function clearTextDrafts() {
  store.write({});
}
