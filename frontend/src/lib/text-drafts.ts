import type { Piece, Region, ScriptChange } from "../../bridge/source-pieces";
import { createPersistentStore } from "./persistent-store";
import { applyRegions, type SourceTree } from "./source-edits";

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

// draftText is the text that the reader typed: the text of each region and
// each script text. When the source of the version did not load, a region
// gives only the text of its pieces, which holds the words that changed.
export function draftText(
  tree: SourceTree | undefined,
  { regions, scripts }: TextDraft["edits"],
): string {
  const text = tree
    ? regionText(tree, regions)
    : regions.map((r) => piecesText(r.pieces)).join("\n\n");
  return [text, ...scripts.map((s) => s.after.trim())].filter(Boolean).join("\n\n");
}

const piecesText = (pieces: Piece[]): string =>
  pieces
    .map((p) => ("text" in p ? p.text : "children" in p ? piecesText(p.children) : ""))
    .join("")
    .trim();

// Elements that start a new line in the text to copy.
const BLOCKS = "address,blockquote,dd,div,dt,figcaption,h1,h2,h3,h4,h5,h6,li,p,pre,tr";
// Marks around each region in the text to copy. The private use characters
// do not occur in documents.
const START = "\uE000";
const END = "\uE001";

// regionText is the text of the regions as the reader sees it on screen, one
// region after another. The regions are written into the source between
// marks, and the marks find them in the text of the parsed result.
function regionText(tree: SourceTree, regions: Region[]): string {
  const marked = regions.map((r) => ({
    ...r,
    pieces: [{ text: START }, ...r.pieces, { text: END }],
  }));
  const applied = applyRegions(tree, marked);
  if ("refused" in applied) return "";
  const { body } = new DOMParser().parseFromString(applied.html, "text/html");
  body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  body.querySelectorAll(BLOCKS).forEach((el) => el.append("\n"));
  return Array.from(
    (body.textContent ?? "").matchAll(/\uE000([^]*?)\uE001/g),
    ([, text]) => text.trim(),
  ).join("\n\n");
}
