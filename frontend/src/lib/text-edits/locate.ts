import {
  describeAnchor,
  resolveAnchor,
  type CommentAnchor,
} from "../../../bridge/anchoring";
import { renderedTextFromRange } from "../../../bridge/anchoring/rendered-text";
import { expandToWholeInlines } from "../../../bridge/text-edit-range";
import { parseSource } from "./source-map";

export type LocatedRange = {
  // Offsets into the html passed to locate.
  start: number;
  end: number;
  html: string;
  text: string;
  // Describes the grown range, so the bridge can preview over the same text.
  anchor: CommentAnchor;
};

export type LocateFailure = "generated" | "crosses-blocks" | "unsupported";

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function renderedTextOfHtml(doc: Document, html: string): string {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const range = doc.createRange();
  range.selectNodeContents(template.content);
  return renderedTextFromRange(range);
}

export function locate(
  html: string,
  anchor: CommentAnchor,
): LocatedRange | LocateFailure {
  const source = parseSource(html);
  if (!source) return "unsupported";
  const { doc } = source;
  const range = resolveAnchor(doc.body, anchor);
  if (!range) return "generated";
  if (
    normalizeSpace(renderedTextFromRange(range)) !== normalizeSpace(anchor.quote ?? "")
  ) {
    return "generated";
  }
  const grown = expandToWholeInlines(range);
  if (!grown) return "crosses-blocks";
  const start = source.position(grown.startContainer, grown.startOffset, "start");
  const end = source.position(grown.endContainer, grown.endOffset, "end");
  if (start === null || end === null || end < start) return "unsupported";
  const slice = html.slice(start, end);
  const text = renderedTextFromRange(grown);
  if (normalizeSpace(renderedTextOfHtml(doc, slice)) !== normalizeSpace(text)) {
    return "unsupported";
  }
  return {
    start,
    end,
    html: slice,
    text,
    anchor: describeAnchor(doc.body, grown) ?? anchor,
  };
}
