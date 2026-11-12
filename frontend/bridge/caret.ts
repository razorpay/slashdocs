// A load of the frame makes a new document, and the selection of the reader
// goes with the old one. The bridge describes the selection by its text
// before the load, and puts it back at the same characters after it.

import { TextRange } from "./anchoring/text-range.ts";

// The selection as offsets of its ends in the text of the body, and the
// text of the body around it, from the offset at.
export type Caret = { start: number; end: number; at: number; text: string };

// The count of characters of text that a caret keeps on each side.
const REACH = 32;

export const isCaret = (value: unknown): value is Caret => {
  const caret = value as Caret | null;
  return (
    [caret?.start, caret?.end, caret?.at].every(Number.isSafeInteger) &&
    typeof caret?.text === "string"
  );
};

// caretOf describes the selection in the body of d, or gives null when the
// selection is not there.
export function caretOf(d: Document): Caret | null {
  const s = d.getSelection();
  const range = s?.rangeCount ? s.getRangeAt(0) : null;
  if (!range || !d.body?.contains(range.commonAncestorContainer)) return null;
  try {
    const { start, end } = TextRange.fromRange(range).relativeTo(d.body);
    const at = Math.max(0, start.offset - REACH);
    const text = d.body.textContent!.slice(at, end.offset + REACH);
    return { start: start.offset, end: end.offset, at, text };
  } catch {
    return null;
  }
}

// placeCaret puts the selection at the characters of caret: at its offsets
// when the text there is the same, or else where the one copy of its text
// is: of all of it, of the text from the start of the selection, or of the
// text up to its end. When the text is not there, the selection stays as
// it is.
export function placeCaret(d: Document, { start, end, at, text }: Caret): void {
  const all = d.body?.textContent ?? "";
  const lead = start - at;
  const parts: [string, number][] = [
    [text, lead],
    [text.slice(lead), 0],
    [text.slice(0, end - at), lead],
  ];
  let found = all.startsWith(text, at) ? start : -1;
  for (const [part, offset] of parts) {
    if (found >= 0) break;
    const copy = all.indexOf(part);
    if (part.trim() && copy >= 0 && copy === all.lastIndexOf(part))
      found = copy + offset;
  }
  if (found < 0) return;
  try {
    const range = TextRange.fromOffsets(d.body, found, found + end - start).toRange();
    d.getSelection()?.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    );
  } catch {
    // The offsets are not in the body.
  }
}
