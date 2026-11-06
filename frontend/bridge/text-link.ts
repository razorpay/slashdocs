import type { CommentAnchor } from "./anchoring/types.ts";

// Keep selected text in the fragment, which is not sent to the server.
// Native :~:text directives cannot target our nested document iframe.
export const TEXT_LINK_PREFIX = "#text=";
export const MAX_LINK_TEXT = 4096;

export function textLinkAnchor(value: unknown): CommentAnchor | null {
  if (!value || typeof value !== "object") return null;
  const a = value as CommentAnchor;
  if (typeof a.quote !== "string" || !a.quote.trim() || a.quote.length > MAX_LINK_TEXT)
    return null;
  if (
    (a.prefix !== undefined &&
      (typeof a.prefix !== "string" || a.prefix.length > 64)) ||
    (a.suffix !== undefined && (typeof a.suffix !== "string" || a.suffix.length > 64))
  )
    return null;
  const anchor: CommentAnchor = { quote: a.quote, prefix: a.prefix, suffix: a.suffix };
  if (
    Number.isSafeInteger(a.start_offset) &&
    Number.isSafeInteger(a.end_offset) &&
    a.start_offset! >= 0 &&
    a.end_offset! > a.start_offset!
  ) {
    anchor.start_offset = a.start_offset;
    anchor.end_offset = a.end_offset;
  }
  return anchor;
}

export function textLinkFragment(value: unknown): string | null {
  const anchor = textLinkAnchor(value);
  if (!anchor) return null;
  const params = new URLSearchParams({ text: anchor.quote! });
  if (anchor.prefix) params.set("prefix", anchor.prefix);
  if (anchor.suffix) params.set("suffix", anchor.suffix);
  if (anchor.start_offset !== undefined) {
    params.set("start", String(anchor.start_offset));
    params.set("end", String(anchor.end_offset));
  }
  return `#${params}`;
}

export function parseTextLink(hash: string): CommentAnchor | null {
  if (!hash.startsWith(TEXT_LINK_PREFIX) || hash.length > 52000) return null;
  const params = new URLSearchParams(hash.slice(1));
  return textLinkAnchor({
    quote: params.get("text"),
    prefix: params.get("prefix") ?? undefined,
    suffix: params.get("suffix") ?? undefined,
    start_offset: params.has("start") ? Number(params.get("start")) : undefined,
    end_offset: params.has("end") ? Number(params.get("end")) : undefined,
  });
}
