// Text edits turn changes made to the rendered text of a document into exact
// find-and-replace edits on its HTML source, the same edits an agent sends.
// The rendered text of a node is its source text with character references
// decoded, so each change is matched back by encoding it again. A change
// starts as the smallest span that differs and takes in neighbouring words
// until it occurs exactly once in the source. A change that cannot be found
// that way is reported, never guessed.

export type TextChange = { before: string; after: string };
export type TextEdit = { old_string: string; new_string: string };
export type UnmatchedChange = TextChange & { reason: "not_found" | "ambiguous" };

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The ways the source can spell a run of text, most likely first. Authors
// and generators differ in whether they escape ">" and how they write a
// non-breaking space.
const SPELLINGS: ((s: string) => string)[] = [
  (s) => escapeText(s).replace(/\u00a0/g, "&nbsp;"),
  (s) => s,
  (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/\u00a0/g, "&nbsp;"),
  (s) => escapeText(s).replace(/\u00a0/g, "&#160;"),
];

function occurrences(source: string, needle: string): number {
  let count = 0;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (++count > 1) break;
  }
  return count;
}

// The start of the word before lo, with the space that ends it.
function widenLeft(text: string, lo: number): number {
  let i = Math.max(0, lo - 1);
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

// The end of the word after hi, with the space that starts it.
function widenRight(text: string, hi: number): number {
  let i = Math.min(text.length, hi + 1);
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

// newText escapes what the reader typed. Browsers type a non-breaking space
// where an ordinary one would collapse, which the source should not keep
// unless the text already used them.
function newText(typed: string, before: string): string {
  const spaces = before.includes("\u00a0") ? typed : typed.replace(/\u00a0/g, " ");
  return escapeText(spaces).replace(/\u00a0/g, "&nbsp;");
}

// editFor finds the edit for one change in source, or why there is none.
export function editFor(
  source: string,
  change: TextChange,
): TextEdit | UnmatchedChange["reason"] {
  const { before, after } = change;
  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Whole words read better in the version history than parts of them.
  while (prefix > 0 && !/\s/.test(before[prefix - 1])) prefix--;
  while (suffix > 0 && !/\s/.test(before[before.length - suffix])) suffix--;
  const typed = after.slice(prefix, after.length - suffix);
  let lo = prefix;
  let hi = before.length - suffix;
  let reason: UnmatchedChange["reason"] = "not_found";
  for (;;) {
    if (hi > lo) {
      for (const spell of SPELLINGS) {
        const old = spell(before.slice(lo, hi));
        const count = occurrences(source, old);
        if (count === 1) {
          return {
            old_string: old,
            new_string:
              spell(before.slice(lo, prefix)) +
              newText(typed, before) +
              spell(before.slice(before.length - suffix, hi)),
          };
        }
        if (count > 1) reason = "ambiguous";
      }
    }
    if (lo === 0 && hi === before.length) return reason;
    lo = widenLeft(before, lo);
    hi = widenRight(before, hi);
  }
}

// buildEdits maps every change to an edit. Each edit is matched against the
// source as the edits before it left it, as the server applies them.
export function buildEdits(
  source: string,
  changes: TextChange[],
): { edits: TextEdit[]; unmatched: UnmatchedChange[] } {
  const edits: TextEdit[] = [];
  const unmatched: UnmatchedChange[] = [];
  let current = source;
  for (const change of changes) {
    if (change.before === change.after) continue;
    const edit = editFor(current, change);
    if (typeof edit === "string") {
      unmatched.push({ ...change, reason: edit });
      continue;
    }
    if (edit.old_string === edit.new_string) continue;
    const at = current.indexOf(edit.old_string);
    current =
      current.slice(0, at) +
      edit.new_string +
      current.slice(at + edit.old_string.length);
    edits.push(edit);
  }
  return { edits, unmatched };
}
