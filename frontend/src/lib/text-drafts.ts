import type { Operation } from "@/api";
import type { Piece, Region, ScriptChange } from "../../bridge/source-pieces";
import { createPersistentStore } from "./persistent-store";
import { applyRegions, type Replacement, type SourceTree } from "./source-edits";

// Text that an editor typed in a document and that the server may not hold.
// It outlives the page, so that the text goes to the server on the next
// visit. It holds no document, only the changes, in a form that the server
// tells apart when it gets one again:
//   op    The operation that waits, with its id: the one on its way, or
//         the text that did not go yet. The server applies an operation
//         with one id once.
//   next  The text typed while op was on its way, as replacements on the
//         source that op makes. It moves over the operations of other
//         people that the answer to op names.
//   version  The version that holds the seq of op, and so the source that
//         next moves from.
//   copy  Text that cannot go to the server, for the reader to copy: text
//         that the server refused, and script text, which must show on the
//         page before it goes.
export type TextDraft = {
  version: string;
  op?: Operation;
  next?: Replacement[];
  copy?: string;
  updatedAt: number;
};

// The edits of a frame that the reader can copy.
type Edits = { regions: Region[]; scripts: ScriptChange[] };

// The drafts of each document, by the id of their writer: each load of the
// frame writes and removes only its own draft.
type TextDrafts = Record<string, TextDraft>;

// The drafts of each principal, by document. A draft goes to the server only
// as the principal who typed it, and shows only to them: on a shared browser,
// the next person never sends or sees the text of the one before.
type Owners = Record<string, Record<string, TextDrafts>>;

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const valid = (d: TextDraft) =>
  typeof d?.version === "string" &&
  (d.op === undefined ||
    (typeof d.op.base_seq === "number" &&
      typeof d.op.client_op_id === "string" &&
      Array.isArray(d.op.replacements))) &&
  (d.next === undefined || Array.isArray(d.next)) &&
  (d.copy === undefined || typeof d.copy === "string") &&
  d.updatedAt > Date.now() - MAX_AGE;

// mapValues gives an object with f applied to each value of o.
const mapValues = <T, U>(o: Record<string, T> | undefined, f: (value: T) => U) =>
  Object.fromEntries(Object.entries(o ?? {}).map(([key, value]) => [key, f(value)]));

// A change to the form of a draft takes a new key.
const store = createPersistentStore<Owners>("slashdocs.text-drafts.v3", {}, (parsed) =>
  mapValues(parsed as Owners, (docs) =>
    mapValues(docs, (drafts) =>
      Object.fromEntries(Object.entries(drafts ?? {}).filter(([, d]) => valid(d))),
    ),
  ),
);

export function readTextDrafts(owner: string, docId: string): TextDrafts {
  return store.read()[owner]?.[docId] ?? {};
}

// When storage is blocked or full, the store keeps the draft for this tab
// only.
export function writeTextDraft(
  owner: string,
  docId: string,
  id: string,
  draft: Omit<TextDraft, "updatedAt">,
) {
  const all = store.read();
  const docs = all[owner] ?? {};
  const drafts = { ...docs[docId], [id]: { ...draft, updatedAt: Date.now() } };
  store.write({ ...all, [owner]: { ...docs, [docId]: drafts } });
}

export function removeTextDraft(owner: string, docId: string, id: string) {
  const all = store.read();
  if (!all[owner]?.[docId]?.[id]) return;
  const drafts = { ...all[owner][docId] };
  delete drafts[id];
  store.write({ ...all, [owner]: { ...all[owner], [docId]: drafts } });
}

// keepTextDraftsOf removes the drafts of each principal other than owner,
// when owner signs in on this browser.
export function keepTextDraftsOf(owner: string) {
  const all = store.read();
  if (Object.keys(all).some((other) => other !== owner))
    store.write(all[owner] ? { [owner]: all[owner] } : {});
}

// Unsaved text must not outlive a sign-out on a shared browser.
export function clearTextDrafts() {
  store.write({});
}

// A load of the frame holds the lock of its draft while it is on its page,
// in each tab of the browser (see enter). Only a draft with no live load is sent
// by another page, so that one text never goes from two senders.
export const draftLock = (id: string) => `slashdocs.text-draft.${id}`;

// unowned runs work for a draft that no live load holds, and does nothing
// for another one. Without locks, as on a page that is not served over
// https, each draft is free.
export async function unowned(id: string, work: () => Promise<void>) {
  if (!navigator.locks) return work();
  await navigator.locks.request(draftLock(id), { ifAvailable: true }, (lock) =>
    lock ? work() : undefined,
  );
}

// typedText is the text of replacements, as the reader sees it.
export function typedText(replacements: Replacement[]) {
  return replacements
    .map(({ new_html }) =>
      new DOMParser().parseFromString(new_html, "text/html").body.textContent?.trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

// draftText is the text that the reader typed: the text of each region and
// each script text. When the source of the version did not load, a region
// gives only the text of its pieces, which holds the words that changed.
export function draftText(tree: SourceTree | undefined, edits: Edits) {
  return draftTexts(tree, edits).join("\n\n");
}

function draftTexts(
  tree: SourceTree | undefined,
  { regions, scripts }: Edits,
): string[] {
  const texts = tree
    ? regionTexts(tree, regions)
    : regions.map((r) => piecesText(r.pieces));
  return [...texts, ...scripts.map((s) => s.after.trim())].filter(Boolean);
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

// regionTexts gives the text of each region as the reader sees it on screen.
// The regions are written into the source between marks, and the marks find
// them in the text of the parsed result.
function regionTexts(tree: SourceTree, regions: Region[]): string[] {
  const marked = regions.map((r) => ({
    ...r,
    pieces: [{ text: START }, ...r.pieces, { text: END }],
  }));
  const applied = applyRegions(tree, marked);
  if ("refused" in applied) return [];
  const { body } = new DOMParser().parseFromString(applied.html, "text/html");
  return Array.from(lineText(body).matchAll(/\uE000([^]*?)\uE001/g), ([, text]) =>
    text.trim(),
  );
}

// lineText is the text of a parsed source, with a new line after each block
// and at each line break.
function lineText(body: HTMLElement): string {
  body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  body.querySelectorAll(BLOCKS).forEach((el) => el.append("\n"));
  return body.textContent ?? "";
}
