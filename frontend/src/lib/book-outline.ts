import type { BookDoc, Outline, OutlineEntry } from "@/lib/books";

// The outline being edited plus the documents that are not in it. Moving a
// chapter out of the outline puts its document back in the pool.
export type Draft = { outline: Outline; pool: BookDoc[] };

export type ChapterPos = { part: number; index: number };
export type Section = "front" | "back";

const clone = <T>(v: T): T => structuredClone(v);

// Parts and planned chapters have no id of their own, so the draft gives each
// a client-only key: a row keeps its React state and focus when it moves.
// outlineOf drops the keys before anything is compared or sent.
type Keyed = { key?: string };
type Part = Outline["parts"][number];
let lastKey = 0;
const newKey = () => `k${++lastKey}`;

export function draftOf(outline: Outline, pool: BookDoc[]): Draft {
  const o = clone(outline);
  const key = (e: OutlineEntry) => {
    if (e.doc === undefined) (e as Keyed).key = newKey();
  };
  o.front.forEach(key);
  o.back.forEach(key);
  for (const p of o.parts) {
    (p as Keyed).key = newKey();
    p.chapters.forEach(key);
  }
  return { outline: o, pool };
}

// The outline as the server takes it: no row keys.
export function outlineOf(o: Outline): Outline {
  const strip = <T extends object>(v: T): T => {
    const rest = { ...v } as T & Keyed;
    delete rest.key;
    return rest;
  };
  return {
    ...o,
    front: o.front.map(strip),
    parts: o.parts.map((p) => ({ ...strip(p), chapters: p.chapters.map(strip) })),
    back: o.back.map(strip),
  };
}

// A stable React key for a row.
export const entryKey = (e: OutlineEntry): string =>
  e.doc !== undefined ? `doc:${e.doc}` : `new:${(e as Keyed).key ?? ""}`;
export const partKey = (p: Part): string => `part:${(p as Keyed).key ?? ""}`;

function insertAt<T>(list: T[], index: number, item: T) {
  list.splice(Math.max(0, Math.min(index, list.length)), 0, item);
}

// Chapters and planned chapters are numbered 1..N across parts, in order.
// Front and back matter have no number. numbers[p][c] is the number of
// chapter c of part p, the same rule the server uses.
export function chapterNumbers(o: Outline): number[][] {
  let n = 0;
  return o.parts.map((p) => p.chapters.map(() => ++n));
}

// An empty subtitle is the same as none.
function canonical(o: Outline): string {
  const c = outlineOf(o);
  if (!c.subtitle) delete c.subtitle;
  return JSON.stringify(c);
}

export function sameOutline(a: Outline, b: Outline): boolean {
  return canonical(a) === canonical(b);
}

// Moves a chapter one step. At the edge of a part it crosses into the
// neighbouring part, so keyboard users can reach every part.
export function moveChapterBy(d: Draft, at: ChapterPos, delta: -1 | 1): Draft {
  const next = clone(d);
  const parts = next.outline.parts;
  const from = parts[at.part]?.chapters;
  if (!from || !from[at.index]) return d;
  const target = at.index + delta;
  if (target >= 0 && target < from.length) {
    [from[at.index], from[target]] = [from[target], from[at.index]];
    return next;
  }
  const other = parts[at.part + delta];
  if (!other) return d;
  const [entry] = from.splice(at.index, 1);
  insertAt(other.chapters, delta < 0 ? other.chapters.length : 0, entry);
  return next;
}

// Moves a chapter to `to`. Within a part the result sits at that index; into
// another part it is inserted before the chapter now at that index.
export function moveChapterTo(d: Draft, from: ChapterPos, to: ChapterPos): Draft {
  const next = clone(d);
  const parts = next.outline.parts;
  const src = parts[from.part]?.chapters;
  const dst = parts[to.part]?.chapters;
  if (!src || !dst || !src[from.index]) return d;
  const [entry] = src.splice(from.index, 1);
  insertAt(dst, to.index, entry);
  return next;
}

export function movePartTo(d: Draft, from: number, to: number): Draft {
  if (from === to || !d.outline.parts[from] || !d.outline.parts[to]) return d;
  const next = clone(d);
  const [part] = next.outline.parts.splice(from, 1);
  next.outline.parts.splice(to, 0, part);
  return next;
}

export function movePartBy(d: Draft, part: number, delta: -1 | 1): Draft {
  return movePartTo(d, part, part + delta);
}

export function moveChapterToPart(d: Draft, from: ChapterPos, part: number): Draft {
  const dst = d.outline.parts[part];
  if (!dst || part === from.part) return d;
  return moveChapterTo(d, from, { part, index: dst.chapters.length });
}

export function addPart(d: Draft, title = "New part"): Draft {
  const next = clone(d);
  next.outline.parts.push({ title, chapters: [], key: newKey() } as Part);
  return next;
}

export function removePart(d: Draft, part: number, titleOf: (id: string) => string) {
  if (!d.outline.parts[part]) return d;
  const next = clone(d);
  const [gone] = next.outline.parts.splice(part, 1);
  for (const e of gone.chapters) poolEntry(next, e, titleOf);
  return next;
}

export function renamePart(d: Draft, part: number, title: string): Draft {
  const next = clone(d);
  if (next.outline.parts[part]) next.outline.parts[part].title = title;
  return next;
}

export function setTitle(d: Draft, field: "title" | "subtitle", value: string): Draft {
  const next = clone(d);
  next.outline[field] = value;
  return next;
}

export function addPlanned(d: Draft, part: number): Draft {
  if (!d.outline.parts[part]) return d;
  const next = clone(d);
  next.outline.parts[part].chapters.push({
    planned: "",
    key: newKey(),
  } as OutlineEntry);
  return next;
}

export function renamePlanned(d: Draft, at: ChapterPos, title: string): Draft {
  const next = clone(d);
  const e = next.outline.parts[at.part]?.chapters[at.index];
  if (e && e.planned !== undefined) e.planned = title;
  return next;
}

function poolEntry(
  d: Draft,
  entry: OutlineEntry | undefined,
  titleOf: (id: string) => string,
) {
  if (entry?.doc) d.pool.push({ id: entry.doc, title: titleOf(entry.doc) });
}

// Takes a chapter out of the outline. A document goes back to the pool; a
// planned chapter is just dropped.
export function removeChapter(
  d: Draft,
  at: ChapterPos,
  titleOf: (id: string) => string,
): Draft {
  const next = clone(d);
  const [entry] = next.outline.parts[at.part]?.chapters.splice(at.index, 1) ?? [];
  poolEntry(next, entry, titleOf);
  return next;
}

export type Target = { part: number } | { section: Section };

// Puts a document from the pool into a part (at the end) or a matter section.
export function addFromPool(d: Draft, docId: string, to: Target): Draft {
  const i = d.pool.findIndex((x) => x.id === docId);
  if (i < 0) return d;
  const next = clone(d);
  next.pool.splice(i, 1);
  if ("section" in to) next.outline[to.section].push({ doc: docId });
  else if (next.outline.parts[to.part])
    next.outline.parts[to.part].chapters.push({ doc: docId });
  else return d;
  return next;
}

export function moveMatterBy(
  d: Draft,
  section: Section,
  index: number,
  delta: -1 | 1,
): Draft {
  const list = d.outline[section];
  const t = index + delta;
  if (!list[index] || t < 0 || t >= list.length) return d;
  const next = clone(d);
  const l = next.outline[section];
  [l[index], l[t]] = [l[t], l[index]];
  return next;
}

export function removeMatter(
  d: Draft,
  section: Section,
  index: number,
  titleOf: (id: string) => string,
): Draft {
  const next = clone(d);
  const [entry] = next.outline[section].splice(index, 1);
  poolEntry(next, entry, titleOf);
  return next;
}

export type Problem = { path: string; message: string };

// Where a validation problem shows. Keys name the row or field a path points
// at; anything the draft has no row for is "summary".
export type RowKey =
  | "title"
  | "subtitle"
  | `part:${number}`
  | `chapter:${number}:${number}`
  | `${Section}:${number}`;

export function rowKeyForPath(path: string, o: Outline): RowKey | null {
  if (path === "title" || path === "subtitle") return path;
  let m = /^parts\[(\d+)\]\.chapters\[(\d+)\](?:\.|$)/.exec(path);
  if (m) {
    const [p, c] = [Number(m[1]), Number(m[2])];
    return o.parts[p]?.chapters[c] ? `chapter:${p}:${c}` : null;
  }
  m = /^parts\[(\d+)\](?:\.title)?$/.exec(path);
  if (m) return o.parts[Number(m[1])] ? `part:${Number(m[1])}` : null;
  m = /^(front|back)\[(\d+)\](?:\.|$)/.exec(path);
  if (m) {
    const sec = m[1] as Section;
    return o[sec][Number(m[2])] ? `${sec}:${Number(m[2])}` : null;
  }
  return null;
}

export function groupProblems(
  problems: Problem[],
  o: Outline,
): { byRow: Map<RowKey, string[]>; summary: Problem[] } {
  const byRow = new Map<RowKey, string[]>();
  const summary: Problem[] = [];
  for (const p of problems) {
    const key = rowKeyForPath(p.path, o);
    if (!key) {
      summary.push(p);
      continue;
    }
    byRow.set(key, [...(byRow.get(key) ?? []), p.message]);
  }
  return { byRow, summary };
}

function parseId(
  id: string,
): { kind: "ch" | "part" | "end"; a: number; b: number } | null {
  const [kind, a, b] = id.split(":");
  if (kind !== "ch" && kind !== "part" && kind !== "end") return null;
  return { kind, a: Number(a), b: Number(b) };
}

// Applies a drop. Chapters land at the row they are dropped on, at the top of
// a part when dropped on its header, or at its end when dropped on its footer.
// Parts land at the part they are dropped on.
export function applyDrop(draft: Draft, activeId: string, overId: string): Draft {
  const from = parseId(activeId);
  const to = parseId(overId);
  if (!from || !to || activeId === overId) return draft;
  if (from.kind === "part") {
    return movePartTo(draft, from.a, to.a);
  }
  if (from.kind !== "ch") return draft;
  const src = { part: from.a, index: from.b };
  if (to.kind === "ch") return moveChapterTo(draft, src, { part: to.a, index: to.b });
  if (to.kind === "part") return moveChapterTo(draft, src, { part: to.a, index: 0 });
  const end = draft.outline.parts[to.a]?.chapters.length ?? 0;
  const same = to.a === src.part;
  return moveChapterTo(draft, src, { part: to.a, index: same ? end - 1 : end });
}
