import type { CommentAnchor } from "../../../bridge/anchoring";
import {
  locate,
  normalizeSpace,
  type LocatedRange,
  type LocateFailure,
} from "./locate";

export type TextEdit = {
  id: string;
  // Offsets into the base html.
  start: number;
  end: number;
  originalHtml: string;
  originalText: string;
  html: string;
  text: string;
  // Locates the original text, in the base with the edits made before this one applied.
  anchor: CommentAnchor;
  // Set when re-applying to a newer version could not find the original text.
  failed?: boolean;
};

const SUMMARY_TEXT_LIMIT = 60;

function placed(edits: TextEdit[]): TextEdit[] {
  return edits.filter((edit) => !edit.failed).sort((a, b) => a.start - b.start);
}

export function applyEdits(base: string, edits: TextEdit[]): string {
  let html = base;
  for (const edit of placed(edits).reverse()) {
    html = html.slice(0, edit.start) + edit.html + html.slice(edit.end);
  }
  return html;
}

// Where each edit sits once the edits are applied, and the total length change up to
// and including it.
function editedSpans(
  edits: TextEdit[],
): { start: number; end: number; shift: number }[] {
  let shift = 0;
  return placed(edits).map((edit) => {
    const start = edit.start + shift;
    shift += edit.html.length - (edit.end - edit.start);
    return { start, end: start + edit.html.length, shift };
  });
}

export function locateForEdit(
  base: string,
  edits: TextEdit[],
  anchor: CommentAnchor,
): LocatedRange | LocateFailure | "overlaps" {
  const located = locate(applyEdits(base, edits), anchor);
  if (typeof located === "string") return located;
  let shift = 0;
  for (const span of editedSpans(edits)) {
    if (located.start <= span.end && located.end >= span.start) return "overlaps";
    if (span.end < located.start) shift = span.shift;
  }
  return { ...located, start: located.start - shift, end: located.end - shift };
}

function truncate(text: string): string {
  const flat = normalizeSpace(text);
  return flat.length > SUMMARY_TEXT_LIMIT
    ? `${flat.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`
    : flat;
}

export function formattingOnly(edit: TextEdit): boolean {
  return normalizeSpace(edit.originalText) === normalizeSpace(edit.text);
}

export function summaryLines(edits: TextEdit[]): string[] {
  return edits
    .filter((edit) => !edit.failed)
    .map((edit) =>
      formattingOnly(edit)
        ? `Formatted "${truncate(edit.text)}"`
        : `Edited "${truncate(edit.originalText)}" → "${truncate(edit.text)}"`,
    );
}

export function reapplyEdits(base: string, edits: TextEdit[]): TextEdit[] {
  const result: TextEdit[] = [];
  for (const edit of edits) {
    const located = locateForEdit(base, result, edit.anchor);
    if (
      typeof located === "string" ||
      normalizeSpace(located.text) !== normalizeSpace(edit.originalText)
    ) {
      result.push({ ...edit, failed: true });
      continue;
    }
    result.push({
      ...edit,
      start: located.start,
      end: located.end,
      originalHtml: located.html,
      anchor: located.anchor,
      failed: false,
    });
  }
  return result;
}
