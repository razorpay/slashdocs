// Comment anchoring engine for the slashdocs render bridge.
//
// Follows the Hypothesis client's anchoring architecture: a selection is
// described as a TextPosition selector (fast, exact) plus a TextQuote
// selector (robust), and resolution tries them in order:
//
//   1. Position: resolve the stored character offsets and verify the text
//      still matches the stored quote.
//   2. Quote: search the whole document text for the quote, verbatim, and
//      choose among its copies by prefix/suffix context and proximity to the
//      stored position. Unlike Hypothesis, no fuzzy match anchors: the API
//      (comment_placement.go) places only verbatim text, and a comment shows
//      as detached rather than on text that only looks like its quote.
//
// All offsets are character offsets into the document body's raw
// `textContent`. Quotes are stored in "rendered" form (each `<br>`
// substituted by a space) so line-broken selections read naturally.
import { matchQuoteCandidates } from "./match-quote.ts";
import {
  rawOffsetToRendered,
  renderedOffsetToRaw,
  renderedTextFromRange,
  renderedTextOf,
  type RenderedTextWithBrPositions,
} from "./rendered-text.ts";
import { TextRange } from "./text-range.ts";
import type { CommentAnchor } from "./types.ts";

export type { CommentAnchor } from "./types.ts";
export { snapToWords } from "./word-range.ts";

/**
 * Number of characters around the quote to capture as prefix/suffix context.
 * Matches the Hypothesis client.
 */
const CONTEXT_LENGTH = 32;

/**
 * Minimum prefix/suffix agreement (`Match.contextScore`) for a verbatim match
 * of an ambiguous quote, one that appears more than once in the document or
 * in its own stored context. Every copy of such a quote matches verbatim, so
 * only the surrounding text says which copy the comment was on; without this
 * floor a comment whose copy was edited jumps to another copy. Measured: the
 * right copy after nearby edits or a moved paragraph scores >= 0.73, another
 * copy of a short repeated phrase ("TBD") scores ~0.5.
 */
const MIN_CONTEXT_SCORE_FOR_AMBIGUOUS_QUOTE = 0.65;

/**
 * Collapse runs of whitespace so quote verification tolerates reformatting
 * that doesn't change visible text.
 */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Whether `quote` occurs more than once in `text`, overlaps included. */
function occursMoreThanOnce(text: string, quote: string): boolean {
  const first = text.indexOf(quote);
  return first !== -1 && text.indexOf(quote, first + 1) !== -1;
}

/**
 * Describe `range` as a comment anchor: a quote with surrounding context plus
 * character offsets into `root.textContent`.
 *
 * Returns `null` if the range contains no non-whitespace text.
 */
export function describeAnchor(root: Element, range: Range): CommentAnchor | null {
  let trimmed: Range;
  try {
    trimmed = TextRange.trimmedRange(range);
  } catch {
    return null;
  }

  try {
    const textRange = TextRange.fromRange(trimmed).relativeTo(root);
    const start = textRange.start.offset;
    const end = textRange.end.offset;
    const rawTextLength = (root.textContent ?? "").length;

    const quote = renderedTextFromRange(trimmed);
    if (!quote.trim()) {
      return null;
    }
    const prefixRange = TextRange.fromOffsets(
      root,
      Math.max(0, start - CONTEXT_LENGTH),
      start,
    ).toRange();
    const suffixRange = TextRange.fromOffsets(
      root,
      end,
      Math.min(rawTextLength, end + CONTEXT_LENGTH),
    ).toRange();

    return {
      quote,
      prefix: renderedTextFromRange(prefixRange),
      suffix: renderedTextFromRange(suffixRange),
      dom_path: "body",
      start_offset: start,
      end_offset: end,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a stored anchor to a DOM Range within `root`, or `null` when the
 * anchor's text can no longer be located with confidence.
 */
export function resolveAnchor(
  root: Element,
  anchor: CommentAnchor,
  getRenderedText?: () => RenderedTextWithBrPositions,
): Range | null {
  // The anchor arrives as JSON from the API; tolerate off-contract field
  // types instead of letting them reach the matcher.
  const quote = typeof anchor.quote === "string" ? anchor.quote : "";
  const prefix = typeof anchor.prefix === "string" ? anchor.prefix : undefined;
  const suffix = typeof anchor.suffix === "string" ? anchor.suffix : undefined;
  const start = anchor.start_offset;
  const end = anchor.end_offset;
  const hasPosition =
    typeof start === "number" && typeof end === "number" && start >= 0 && end > start;

  // Tier 1: character offsets, verified against the stored quote so a stale
  // position can never produce a wrong highlight.
  if (hasPosition) {
    try {
      const range = TextRange.fromOffsets(root, start, end).toRange();
      const rendered = renderedTextFromRange(range);
      if (
        !quote ||
        rendered === quote ||
        normalizeSpace(rendered) === normalizeSpace(quote)
      ) {
        return range;
      }
    } catch {
      // Offsets exceed the document text; fall through to the quote tier.
    }
  }

  if (!quote) {
    return null;
  }

  // Tier 2: verbatim quote search over the whole document text,
  // disambiguated by context and the stored position.
  const { text, brPositionsInText } = getRenderedText
    ? getRenderedText()
    : renderedTextOf(root);
  if (!text.includes(quote)) {
    return null;
  }
  // Each candidate is a verbatim copy of the quote.
  const candidates = matchQuoteCandidates(text, quote, {
    prefix,
    suffix,
    // The stored offset is a raw-textContent position while matchQuote works
    // in rendered coordinates, so convert it (they drift apart by one per
    // preceding <br>). Clamp too: offsets from a longer prior version would
    // push posScore negative.
    hint: hasPosition
      ? Math.min(rawOffsetToRendered(brPositionsInText, start), text.length)
      : undefined,
  });
  // A quote that appears once always anchors, also when its surrounding
  // context was rewritten. A quote that is repeated, in the document now or
  // around the comment when it was made, instead anchors on a copy whose
  // context agrees, so an edit to the commented copy detaches the comment
  // rather than moving it to another copy. Any such copy will do, as in the
  // API's placement check: the best scoring one can lead on the position
  // hint alone.
  const ambiguous =
    candidates.length > 1 ||
    occursMoreThanOnce(`${prefix ?? ""}${quote}${suffix ?? ""}`, quote);
  const match = ambiguous
    ? candidates.find((m) => m.contextScore >= MIN_CONTEXT_SCORE_FOR_AMBIGUOUS_QUOTE)
    : candidates[0];
  if (!match) {
    return null;
  }
  try {
    return TextRange.fromOffsets(
      root,
      renderedOffsetToRaw(brPositionsInText, match.start),
      renderedOffsetToRaw(brPositionsInText, match.end),
    ).toRange();
  } catch {
    return null;
  }
}
