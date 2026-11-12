// The merge of live co-editing, in the browser. The server holds the same
// rules in internal/textedit (Transform), and the cases in merge-cases.json
// bind both.

import { wordChanges, type Change, type Replacement } from "./source-edits";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// applyReplacements gives the source after the replacements, or undefined
// when one does not fit: its range is not in the source, or old_html is not
// the text at its range.
export function applyReplacements(
  source: string,
  replacements: Replacement[],
): string | undefined {
  const bytes = encoder.encode(source);
  const text = (start: number, end: number) =>
    decoder.decode(bytes.subarray(start, end));
  // Whether a character of the source starts at the byte, or the source
  // ends there.
  const boundary = (at: number) => at === bytes.length || (bytes[at] & 0xc0) !== 0x80;
  let html = "";
  let at = 0;
  for (const { start, end, old_html, new_html } of replacements) {
    const fits =
      at <= start &&
      start <= end &&
      end <= bytes.length &&
      boundary(start) &&
      boundary(end) &&
      text(start, end) === old_html;
    if (!fits) return undefined;
    html += text(at, start) + new_html;
    at = end;
  }
  return html + text(at, bytes.length);
}

// applyOps gives the source after the operations, in order, or undefined
// when a replacement does not fit.
export function applyOps(source: string, ops: Replacement[][]): string | undefined {
  let next: string | undefined = source;
  for (const op of ops) next = next === undefined ? next : applyReplacements(next, op);
  return next;
}

// A range of a source, from start to end.
export type Range = [start: number, end: number];

// mergeOps gives ours, a source made from base, with the operations that
// other people made on base, in order: each one merges on the source before
// it, as merge3 does. The operations fit base. marks are the ranges of the
// result that the operations put in, in order, with no overlap. While ours
// is base, an operation applies as it is, so its ranges are exactly where
// the server put its text.
export function mergeOps(
  base: string,
  ours: string,
  ops: Replacement[][],
): { source: string; marks: Range[] } {
  let marks: Range[] = [];
  for (const op of ops) {
    // With no text of ours, the merged source is the next base.
    const same = ours === base;
    ({ source: ours, marks } = merge(base, ours, op, marks));
    base = same ? ours : (applyReplacements(base, op) ?? base);
  }
  return { source: ours, marks };
}

// The table of CRC-32 (IEEE), by byte.
const CRC = Uint32Array.from({ length: 256 }, (_, byte) => {
  let c = byte;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

// sumOf gives the CRC-32 of the UTF-8 bytes of a source, as an unsigned
// number. The server sends the same sum with each state, so a client that
// does not hold that state learns it.
export function sumOf(source: string): number {
  let c = 0xffffffff;
  for (const byte of encoder.encode(source)) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// merge3 gives the source that holds the changes from base to ours and from
// base to theirs. It never refuses. Text of base stays only when the two
// sides keep it. New text goes in where its change starts, and at the same
// point the text of ours comes first, as on the server: a person who types
// on adds to the end of their own text. Text that goes in at a point comes
// before a change that takes out the text from that point. A change in one
// tag, as of an attribute, goes when the other side takes out the text
// around it, as the attribute or the whole tag: it has no place (see
// removes). When the two sides replace text that overlaps, the two new
// texts stay whole, the one of ours first (see wholeWords). theirs is the other source, or the replacements that make
// it from base, as the server gives them: those are exact also for a change
// too large for the diff here, and also among equal characters (see
// changesOf).
export function merge3(
  base: string,
  ours: string,
  theirs: string | Replacement[],
): string {
  return merge(base, ours, theirs).source;
}

// A change of the merge. mine counts the units at the start of text that
// ours made: the rest is text of theirs. A change of theirs has no mine.
type Merged = Change & { mine?: number };

// A change of ours: all of its text is text that ours made.
const mineOf = (change: Change): Merged => ({ ...change, mine: change.text.length });

// merge is merge3, and also gives the ranges of the merged source that
// theirs put in. held are such ranges of ours, from the operations before:
// they move with their text.
function merge(
  base: string,
  ours: string,
  theirs: string | Replacement[],
  held: Range[] = [],
): { source: string; marks: Range[] } {
  const sides = sheltered(
    base,
    aligned(base, [
      changesBetween(base, ours).map(mineOf),
      typeof theirs === "string"
        ? changesBetween(base, theirs)
        : changesOf(base, theirs),
    ]),
  );
  // The sort is stable, so ours stays first at the same point. Of two
  // changes from one start, the longer one comes first, so that it is the
  // reach of the other (see removes).
  const changes: Merged[] = wholeWords(base, sides).sort(
    (a, b) =>
      a.start - b.start || +(a.end > a.start) - +(b.end > b.start) || b.end - a.end,
  );
  let source = "";
  let at = 0;
  // The offset in ours of a place of base that ours keeps, less that place.
  let shift = 0;
  // The parts of ours that the merged source keeps: the offset of each one
  // in ours and in the merged source, and its length.
  const kept: [ours: number, merged: number, length: number][] = [];
  const keep = (from: number, length: number) => {
    if (length > 0) kept.push([from + shift, source.length, length]);
  };
  const marks: Range[] = [];
  // The change before that reaches furthest.
  let reach: Change = { start: 0, end: 0, text: "" };
  for (const change of changes) {
    const { start, end } = change;
    // A change in a tag has no place when the other side takes out the
    // text around it.
    const text = removes(base, reach, change) ? "" : change.text;
    const mine = Math.min(change.mine ?? 0, text.length);
    // A change that starts in text that an earlier one removed only adds
    // its own text.
    keep(at, start - at);
    source += base.slice(at, start);
    keep(start, mine);
    if (mine < text.length)
      marks.push([source.length + mine, source.length + text.length]);
    source += text;
    if (change.mine !== undefined) shift += change.mine - (end - start);
    at = Math.max(at, end);
    if (end > reach.end) reach = change;
  }
  keep(at, base.length - at);
  source += base.slice(at);
  // A range that ours held is now from its first unit that stays to its
  // last one.
  const moved = held.flatMap(([from, to]): Range[] => {
    const first = kept.find(([part, , length]) => part + length > from);
    const last = kept.filter(([part]) => part < to).at(-1);
    if (!first || !last) return [];
    const start = first[1] + Math.max(from - first[0], 0);
    const end = last[1] + Math.min(to - last[0], last[2]);
    return start < end ? [[start, end]] : [];
  });
  return { source, marks: union([...moved, ...marks]) };
}

// union gives ranges in order, with each two that touch or overlap as one.
function union(ranges: Range[]): Range[] {
  const all: Range[] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = all.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else all.push([start, end]);
  }
  return all;
}

// A letter or a digit: a character of a word.
const LETTER = /^[\p{L}\p{N}]$/u;
// words widens each end by at most this many characters. A run of letters
// and digits can be very long, as in a data URI.
const WORD_REACH = 64;

// words widens start and end to the ends of the words of base that they are
// in, by at most WORD_REACH characters each.
function words(base: string, start: number, end: number): [number, number] {
  const before = (at: number) => lastCharacter(base.slice(Math.max(at - 2, 0), at));
  const after = (at: number) => firstCharacter(base.slice(at, at + 2));
  const inWord = (at: number) => LETTER.test(before(at)) && LETTER.test(after(at));
  for (let i = 0; i < WORD_REACH && inWord(start); i++) start -= before(start).length;
  for (let i = 0; i < WORD_REACH && inWord(end); i++) end += after(end).length;
  return [start, end];
}

// wholeWords gives the changes of the two sides, with one change in place
// of each two that replace text that overlaps. Parts of two new words in one
// word read as neither, so the two changes become one that removes their
// two ranges together, out to the ends of the words of base there, and puts
// in that text as each side made it, the text of the first side first.
// "cat" to "cow" and "cat" to "cup" give "cowcup". Each other change of a
// side in that text is a part of what the side made.
function wholeWords(base: string, sides: Change[][]): Merged[] {
  const joined = new Set<Change>();
  const whole: Merged[] = [];
  for (const mine of sides[0])
    for (const other of sides[1]) {
      const apart = mine.end <= other.start || other.end <= mine.start;
      if (apart || !replaces(mine) || !replaces(other) || joined.has(mine)) continue;
      let start = Math.min(mine.start, other.start);
      let end = Math.max(mine.end, other.end);
      let parts: Change[][] = [];
      // The range goes out to the ends of its words. Another change that
      // lies across an end makes it larger, and its ends are then in other
      // words.
      for (let grown = true; grown;) {
        [start, end] = words(base, start, end);
        parts = sides.map((side) =>
          side.filter((c) => c.start < end && c.end > start && !joined.has(c)),
        );
        const low = Math.min(start, ...parts.flat().map((c) => c.start));
        const high = Math.max(end, ...parts.flat().map((c) => c.end));
        grown = low < start || high > end;
        [start, end] = [low, high];
      }
      for (const change of parts.flat()) joined.add(change);
      const [first, second] = parts.map((part) => applyChanges(base, part, start, end));
      whole.push({ start, end, text: first + second, mine: first.length });
    }
  return [...whole, ...sides.flat().filter((change) => !joined.has(change))];
}

// aligned moves the insertions and the deletions of the two sides to the
// places that fit the changes of the other side, as on the server. Such a
// change gives the same text at each place that place moves it over, but
// its one place can start before the text that its person selected:
// "Remove it. " after "this." is also ". Remove it". It can then be in the
// text that the other side changes, where its person did not put it. The
// places depend only on the two changes, so both orders give the same
// places.
//
// Two deletions that overlap or touch at one of their places move to the
// places where they overlap most (see toward). With another deletion that
// takes out the end of "it. ", the full stop of "this." would also go.
//
// Another insertion or deletion that is in the text that the other side
// changes moves on, out of that text (see clear). When the other person
// changes "this." to "this!", ". Remove it" would leave the full stop.
function aligned(base: string, sides: Merged[][]): Merged[][] {
  const [a, b] = sides;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const [x, y] = [a[i], b[j]];
    if (deletes(x) && deletes(y)) {
      // The deletion that starts first moves first.
      if (y.start < x.start) {
        b[j] = toward(base, b, j, x);
        a[i] = toward(base, a, i, b[j]);
      } else {
        a[i] = toward(base, a, i, y);
        b[j] = toward(base, b, j, a[i]);
      }
    } else if (inside(x, y) || inside(y, x)) {
      // An insertion moves first, and a deletion moves when the insertion
      // cannot.
      if (x.start === x.end) {
        a[i] = clear(base, a, i, y);
        b[j] = clear(base, b, j, a[i]);
      } else {
        b[j] = clear(base, b, j, x);
        a[i] = clear(base, a, i, b[j]);
      }
    }
    const [ends, other] = [a[i].end, b[j].end];
    if (ends <= other) i++;
    if (other <= ends) j++;
  }
  return sides;
}

// toward moves the deletion side[i] toward the deletion other while that
// makes their overlap larger. It stays where it is when the two do not then
// overlap or touch.
function toward(base: string, side: Merged[], i: number, other: Change): Merged {
  const moved = slide(
    base,
    side,
    i,
    ({ start, end }) => start < other.start && end < other.end,
    ({ start, end }) => start > other.start && end > other.end,
  );
  return moved.start <= other.end && other.start <= moved.end ? moved : side[i];
}

// clear moves the insertion or deletion side[i] on, to the first place out
// of the text that other changes. It stays where it is when it has no such
// place: at a place between, its text would go in in another order.
function clear(base: string, side: Merged[], i: number, other: Change): Merged {
  const moved = slide(
    base,
    side,
    i,
    (change) => inside(change, other),
    () => false,
  );
  return inside(moved, other) ? side[i] : moved;
}

// slide gives the insertion or deletion side[i], moved on one character at
// a time while on tells, and then back while back tells. Each step gives
// the same text, and slide stops at a step that does not. It moves by at
// most PLACE_REACH characters each way, stays between the changes of the
// side around side[i], and does not take an end into a tag or out of it.
function slide(
  base: string,
  side: Merged[],
  i: number,
  on: (change: Change) => boolean,
  back: (change: Change) => boolean,
): Merged {
  const change = side[i];
  let { start, end } = change;
  let moved = change.text || base.slice(start, end);
  const [low, high] = around(base, side, i);
  // As in place, both ends step over the same character, and their tags
  // change only where it is a "<" or a ">".
  const [head, tail] = [tagAt(base, start)?.[0], tagAt(base, end)?.[0]];
  const step = (by: number, character: string) => {
    if (
      /[<>]/.test(character) &&
      (tagAt(base, start + by)?.[0] !== head || tagAt(base, end + by)?.[0] !== tail)
    )
      return false;
    [start, end] = [start + by, end + by];
    return true;
  };
  const at = () => ({ start, end, text: change.text });
  for (let moves = 0; moves < PLACE_REACH && on(at()); moves++) {
    const first = firstCharacter(moved);
    const n = first.length;
    if (end + n > high || !base.startsWith(first, end) || !step(n, first)) break;
    moved = moved.slice(n) + first;
  }
  for (let moves = 0; moves < PLACE_REACH && back(at()); moves++) {
    const last = lastCharacter(moved);
    const n = last.length;
    if (start - n < low || !base.startsWith(last, start - n) || !step(-n, last)) break;
    moved = last + moved.slice(0, -n);
  }
  return { ...change, start, end, text: change.text && moved };
}

// inside tells whether x, an insertion or a deletion, is in the text that y
// changes, as on the server. A deletion is in a replacement that it
// overlaps, and around an insertion in its text: two deletions move toward
// each other instead. An insertion is in a change that takes out the text
// from its point on, because its text goes in before the new text of that
// change.
function inside(x: Change, y: Change): boolean {
  if (deletes(x))
    return x.start < y.end && y.start < x.end && (replaces(y) || y.start === y.end);
  return x.start === x.end && x.text !== "" && y.start <= x.start && x.start < y.end;
}

// sheltered keeps text that one side types in an element that the other
// side deletes whole, as with a select-all, in that element, as on the
// server. The text then stays in its paragraph, list item or cell, and does
// not go in bare between the blocks that are left. Each deletion keeps the
// start and end tags of the elements around such text that it takes out
// whole (see shelter), and takes out only the text between them.
function sheltered(base: string, [a, b]: Merged[][]): Merged[][] {
  const split = (side: Merged[], other: Change[]) =>
    side.flatMap((change) => {
      const tags = shelter(base, change, other);
      if (!tags) return [change];
      const parts: Merged[] = [];
      let at = change.start;
      for (const [start, end] of [...tags, [change.end, change.end]]) {
        if (start > at) parts.push({ ...change, start: at, end: start });
        at = Math.max(at, end);
      }
      return parts;
    });
  return [split(a, b), split(b, a)];
}

// shelter gives, in order, the start and end tags that the deletion d keeps:
// those of the elements around the changes of others in d that d takes out
// whole. It gives none when a change of others is not all in d, or has a tag
// in its old text, or is in a tag, where it has no place (see removes).
function shelter(base: string, d: Change, others: Change[]): Range[] | undefined {
  if (!deletes(d)) return undefined;
  const inside = others.filter(({ start, end }) => end > d.start && start < d.end);
  const fits = ({ start, end }: Change) =>
    start >= d.start &&
    end <= d.end &&
    !/[<>]/.test(base.slice(start, end)) &&
    !tagAt(base, start);
  if (!inside.every(fits)) return undefined;
  const tags = inside
    .flatMap(({ start }) => sheltering(base, d, start))
    .sort((x, y) => x[0] - y[0])
    .filter((tag, i, all) => tag[0] !== all[i - 1]?.[0]);
  return tags.length ? tags : undefined;
}

// sheltering gives the start and end tags of the elements that are open at
// at, which is outside tags, and that the deletion d takes out whole. A start
// tag opens its element, and an end tag closes the nearest open element of
// its name. An element with no end tag in d, as a br, is not one of them.
function sheltering(base: string, d: Change, at: number): Range[] {
  const open: { name: string; tag: Range }[] = [];
  const tags: Range[] = [];
  // open[:around] are the elements that are open at at.
  let around = -1;
  for (let i = d.start; i < d.end; i++) {
    if (around < 0 && i >= at) around = open.length;
    if (base[i] !== "<" || i + 1 === d.end || !/^[a-zA-Z/!?]$/.test(base[i + 1]))
      continue;
    const tag: Range = [i, tagEnd(base, i, d.end)];
    const name = tagName(base.slice(i + 1, tag[1]));
    i = tag[1] - 1;
    if (!name.startsWith("/")) {
      if (name) open.push({ name, tag });
      continue;
    }
    let k = open.length - 1;
    while (k >= 0 && open[k].name !== name.slice(1)) k--;
    if (k < 0) continue;
    if (k < around) {
      tags.push(open[k].tag, tag);
      around = k;
    }
    open.length = k;
  }
  return tags;
}

// tagName gives the name of a tag in lower case, with the "/" of an end tag.
// text is the text of the tag after its "<". A comment or a declaration has
// no name.
const tagName = (text: string) =>
  /^[!?]/.test(text) ? "" : (/^.[\p{L}\p{N}-]*/u.exec(text)?.[0] ?? "").toLowerCase();

// tagEnd gives the offset after the ">" that ends the tag that starts at
// start, or limit. In a tag, a ">" in quotes is part of an attribute.
function tagEnd(source: string, start: number, limit: number): number {
  let quote = "";
  for (let i = start + 1; i < limit; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return limit;
}

// Whether a change removes text and adds none.
const deletes = ({ start, end, text }: Change) => end > start && text === "";

// applyChanges gives the text of source from start to end after the changes,
// which are in that range, in order.
function applyChanges(source: string, changes: Change[], start: number, end: number) {
  let text = "";
  for (const change of changes) {
    text += source.slice(start, change.start) + change.text;
    start = change.end;
  }
  return text + source.slice(start, end);
}

// Whether a change removes text and adds other text.
const replaces = ({ start, end, text }: Change) => end > start && text !== "";

// changesOf gives replacements of source, which they fit, as minimal
// changes: at offsets of the string, not of its bytes. Each change stays
// where the replacement has it. Among equal characters only the server
// knows whose each one is: two people type a space at one caret, and the
// server puts the space of the other person after ours. A move back to the
// one place (see place) would put it before ours, and the next key of ours
// would then go after the text of the other person.
function changesOf(source: string, replacements: Replacement[]): Change[] {
  const bytes = encoder.encode(source);
  // The count of string units before the byte from, counted from the last
  // replacement on.
  let byte = 0;
  let unit = 0;
  const unitAt = (to: number) => {
    unit += decoder.decode(bytes.subarray(byte, to)).length;
    byte = to;
    return unit;
  };
  return placed(
    source,
    replacements.map(({ start, end, new_html }) => ({
      start: unitAt(start),
      end: unitAt(end),
      text: new_html,
    })),
    true,
  );
}

// changesBetween gives the minimal changes that turn prev into next, in
// order. Each change is a run of words that differs, without the common
// start and end of its old and new text, so that two people who type in one
// word do not replace the same word.
export function changesBetween(prev: string, next: string): Change[] {
  return placed(prev, wordChanges(prev, next));
}

// placed gives each change of source in its minimal form, in parts at the
// edges of tags (see apart), at its one place (see place), or where it is
// with exact, and with no end in a tag that it does not stay in (see
// outside).
function placed(source: string, changes: Change[], exact = false): Change[] {
  const least = changes.flatMap((change) => apart(source, change));
  if (!exact) each(source, least, place);
  return each(source, least, outside);
}

// apart gives the parts of a change, minimal and with no part that changes
// nothing, as on the server. An end of the change in a tag that it does not
// stay in cuts it at the edge of that tag, when the new text has that edge
// too: "b>bold</b" to "i>BOLD</i" is "b" to "i" in the start tag, "bold" to
// "BOLD" between the tags, and "/b" to "/i" in the end tag. A part then
// changes one tag or only text. So a change of a tag has no place when the
// other side takes out that tag (see removes), and the change of the text
// stays. An end that does not cut stays for outside.
function apart(source: string, change: Change): Change[] {
  const { start, end, text } = minimal(source, change);
  if (source.slice(start, end) === text) return [];
  if (!across(source, start, end)) return [{ start, end, text }];
  // at is the "<" or ">" of the tag in the source, and cut is the same edge
  // in the new text.
  const [head, tail] = [tagAt(source, start), tagAt(source, end)];
  let [at, cut] = head ? [head[1] - 1, text.indexOf(">")] : [-1, -1];
  if (cut < 0 && tail) [at, cut] = [tail[0], text.lastIndexOf("<")];
  if (cut < 0) return [{ start, end, text }];
  return [
    ...apart(source, { start, end: at, text: text.slice(0, cut) }),
    ...apart(source, { start: at + 1, end, text: text.slice(cut + 1) }),
  ];
}

// each moves the changes, in order, with move, each one between low, the
// end of the one before it, and high, the start of the one after it.
function each(
  source: string,
  changes: Change[],
  move: (source: string, change: Change, low: number, high: number) => Change,
): Change[] {
  changes.forEach((change, i) => {
    changes[i] = move(source, change, ...around(source, changes, i));
  });
  return changes;
}

// around gives low, the end of the change before changes[i], and high, the
// start of the one after it. With no such change, it is the start or the end
// of source.
const around = (source: string, changes: Change[], i: number): Range => [
  changes[i - 1]?.end ?? 0,
  changes[i + 1]?.start ?? source.length,
];

// place moves a change back by at most this many characters. A run of one
// character can be very long.
const PLACE_REACH = 1024;

// place moves a change that only adds or only removes text back while the
// character before it is its last character. " Alpha." before " Two." is
// the same change as "Alpha. " one character later, and a diff gives one of
// them by chance. At the one place, two people who type at one caret put
// their text in at one point, and no space goes to the wrong side. The move
// stops where the text starts with a tag: a new paragraph is at the tag that
// starts it, not at the point where a person types in the paragraph after
// it. From a place with an end in a tag that the change does not stay in,
// it moves on to the first place with no such end: a removed paragraph,
// with the start tag of the next one that it joins, starts after the start
// tag that stays, not in it. The change stays after low, the end of the
// change before it, and before high, the start of the change after it, and
// moves by at most PLACE_REACH characters each way, as on the server. A
// change that replaces text, or that changes nothing, stays where it is.
function place(source: string, change: Change, low: number, high: number): Change {
  let { start, end } = change;
  if (end > start === !!change.text) return change;
  let moved = change.text || source.slice(start, end);
  for (
    let last = lastCharacter(moved), moves = 0;
    moves < PLACE_REACH &&
    moved[0] !== "<" &&
    start - last.length >= low &&
    source.startsWith(last, start - last.length);
    last = lastCharacter(moved), moves++
  ) {
    moved = last + moved.slice(0, -last.length);
    start -= last.length;
    end -= last.length;
  }
  // Both ends step over the same character, and their tags change only
  // where it is a "<" or a ">". So the tags are read again only there, and
  // the move is linear.
  let [head, tail] = [tagAt(source, start)?.[0], tagAt(source, end)?.[0]];
  for (let moves = 0; moves < PLACE_REACH && head !== tail; moves++) {
    const first = firstCharacter(moved);
    if (end + first.length > high || !source.startsWith(first, end)) break;
    moved = moved.slice(first.length) + first;
    start += first.length;
    end += first.length;
    if (first === "<" || first === ">")
      [head, tail] = [tagAt(source, start)?.[0], tagAt(source, end)?.[0]];
  }
  return { start, end, text: change.text && moved };
}

// tagAt gives the range of the tag of source that at is in, from its "<" to
// after its ">", or undefined when at is not between the two.
function tagAt(source: string, at: number): Range | undefined {
  const open = at > 0 ? source.lastIndexOf("<", at - 1) : -1;
  const shut = source.indexOf(">", at);
  const next = source.indexOf("<", at);
  const inside =
    open > (at > 0 ? source.lastIndexOf(">", at - 1) : -1) &&
    shut >= 0 &&
    (next < 0 || next > shut);
  return inside ? [open, shut + 1] : undefined;
}

// across tells whether a change of source from start to end has an end in
// a tag that it does not stay in. A change in one tag, as of an attribute,
// stays there. Text that another person puts in at the place of such a
// change would go into the tag.
function across(source: string, start: number, end: number): boolean {
  return tagAt(source, start)?.[0] !== tagAt(source, end)?.[0];
}

// removes tells whether x takes out the text around y, which stays in one
// tag of source, as the attribute that y changes or the whole tag. The
// change of y then has no place: in the tag that x leaves, it can join the
// name of the tag or of another attribute. x takes out all the text of y
// and more, or the text on both sides of an insertion y. x can end where y
// ends: place can move a removed attribute to start at the quote before it.
function removes(source: string, x: Change, y: Change): boolean {
  if (!covers(x, y)) return false;
  const tag = tagAt(source, y.start);
  return tag !== undefined && y.end < tag[1];
}

// covers tells whether x takes out the text of y and more, or the text on
// both sides of y when y only adds text.
const covers = (x: Change, y: Change) =>
  x.start <= y.start &&
  y.end <= x.end &&
  x.start < y.end &&
  y.start < x.end &&
  x.end - x.start > y.end - y.start;

// outside widens each end of a change that is in a tag that the change does
// not stay in to the edge of that tag, with the text of the tag in its new
// text, as on the server. It does not widen to before low or after high.
function outside(source: string, change: Change, low: number, high: number): Change {
  if (!across(source, change.start, change.end)) return change;
  let { start, end, text } = change;
  const [head, tail] = [tagAt(source, start), tagAt(source, end)];
  if (head && head[0] >= low)
    [start, text] = [head[0], source.slice(head[0], start) + text];
  if (tail && tail[1] <= high)
    [end, text] = [tail[1], text + source.slice(end, tail[1])];
  return { start, end, text };
}

const highSurrogate = (unit: string) => unit >= "\ud800" && unit <= "\udbff";
const lowSurrogate = (unit: string) => unit >= "\udc00" && unit <= "\udfff";
// The last character of a text, and the first one: one unit, or the two of
// a surrogate pair.
const lastCharacter = (text: string) =>
  text.slice(lowSurrogate(text.at(-1) ?? "") ? -2 : -1);
const firstCharacter = (text: string) =>
  text.slice(0, highSurrogate(text[0] ?? "") ? 2 : 1);

// minimal cuts the common start and end of the old and new text of a
// change. It cuts whole characters, never half of a surrogate pair.
function minimal(prev: string, { start, end, text }: Change): Change {
  const old = prev.slice(start, end);
  const most = Math.min(old.length, text.length);
  let head = 0;
  while (head < most && old[head] === text[head]) head++;
  if (head && highSurrogate(old[head - 1])) head--;
  let tail = 0;
  while (tail < most - head && old.at(-1 - tail) === text.at(-1 - tail)) tail++;
  if (tail && lowSurrogate(old[old.length - tail])) tail--;
  return {
    start: start + head,
    end: end - tail,
    text: text.slice(head, text.length - tail),
  };
}
