// The merge of live co-editing, in the browser. The server holds the same
// rules in internal/textedit (Merge), and the cases in merge-cases.json
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

// merge3 gives the source that holds the changes from base to ours and from
// base to theirs. It never refuses. Text of base stays only when the two
// sides keep it. New text goes in where its change starts, and at the same
// point the text of ours comes first, as on the server: a person who types
// on adds to the end of their own text. Text that goes in at a point comes
// before a change that takes out the text from that point. theirs is the other source, or the
// replacements that make it from base, as the server gives them: those are
// exact also for a change too large for the diff here.
export function merge3(
  base: string,
  ours: string,
  theirs: string | Replacement[],
): string {
  const changes = [
    ...changesBetween(base, ours),
    ...(typeof theirs === "string"
      ? changesBetween(base, theirs)
      : changesOf(base, theirs)),
    // The sort is stable, so ours stays first at the same point.
  ].sort((a, b) => a.start - b.start || +(a.end > a.start) - +(b.end > b.start));
  let merged = "";
  let at = 0;
  for (const { start, end, text } of changes) {
    // A change that starts in text that an earlier one removed only adds
    // its own text.
    merged += base.slice(at, start) + text;
    at = Math.max(at, end);
  }
  return merged + base.slice(at);
}

// changesOf gives replacements of source, which they fit, as minimal
// changes: at offsets of the string, not of its bytes.
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
  return replacements.map(({ start, end, new_html }) =>
    atTag(
      source,
      minimal(source, { start: unitAt(start), end: unitAt(end), text: new_html }),
    ),
  );
}

// changesBetween gives the minimal changes that turn prev into next, in
// order. Each change is a run of words that differs, without the common
// start and end of its old and new text, so that two people who type in one
// word do not replace the same word.
export function changesBetween(prev: string, next: string): Change[] {
  return wordChanges(prev, next)
    .map((change) => atTag(prev, minimal(prev, change)))
    .filter(({ start, end, text }) => end > start || text);
}

// atTag moves an insertion or a deletion of markup to where it starts with
// a tag. A new paragraph before "<p>omega" can be the text "<p>new</p>"
// before that tag, or "new</p><p>" after it, with the same result. The
// second is at the point where a person types at the start of "omega", so
// the first is the one to use: the two changes are then at two points.
function atTag(prev: string, change: Change): Change {
  const { start, end, text } = change;
  const moved = end > start ? prev.slice(start, end) : text;
  if ((end > start && text) || !moved || moved[0] === "<") return change;
  // The change can move back while the unit before it is its last unit.
  for (
    let k = 1;
    k <= moved.length && k <= start && prev[start - k] === moved.at(-k);
    k++
  ) {
    if (prev[start - k] !== "<") continue;
    return {
      start: start - k,
      end: end - k,
      text: text && moved.slice(-k) + moved.slice(0, -k),
    };
  }
  return change;
}

const highSurrogate = (unit: string) => unit >= "\ud800" && unit <= "\udbff";
const lowSurrogate = (unit: string) => unit >= "\udc00" && unit <= "\udfff";

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
