import type { Anchor, AnchorPoint, Comment, Principal } from "@/api";
import { samePrincipal } from "@/lib/principals";

// Point comments ("pins"): comments on a spot in an element instead of on
// selected text. See AnchorPoint.

export type PointAnchor = Partial<Anchor> & { point: AnchorPoint };

const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;
const PATH = /^(\d{1,5}(\.\d{1,5}){0,63})?$/;
const MAX_LABEL = 128;
// A spot may lie outside its element up to this many times its size, and
// its page spot this many pixels into the page, as the server takes.
const MAX_FRACTION = 1000;
const MAX_PAGE = 10_000_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const within = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const optionalText = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length <= max);

// parsePointAnchor accepts a point anchor from the render frame, which also
// runs the document's own scripts, and keeps only the fields the API takes.
export function parsePointAnchor(value: unknown): PointAnchor | null {
  const a = (value ?? {}) as Record<string, unknown>;
  const p = (a.point ?? {}) as Record<string, unknown>;
  const { target, path, label, x, y, page_x, page_y, viewport_w } = p;
  if (
    !within(x, -MAX_FRACTION, MAX_FRACTION) ||
    !within(y, -MAX_FRACTION, MAX_FRACTION) ||
    !(target === undefined || (typeof target === "string" && TARGET.test(target))) ||
    !(path === undefined || (typeof path === "string" && PATH.test(path))) ||
    !optionalText(label, MAX_LABEL) ||
    (typeof label === "string" && CONTROL.test(label)) ||
    !optionalText(a.quote, 4096) ||
    !optionalText(a.prefix, 256) ||
    !optionalText(a.suffix, 256)
  )
    return null;
  const offset = (n: unknown) => (typeof n === "number" && n >= 0 ? n : undefined);
  const page = within(page_x, 0, MAX_PAGE) &&
    within(page_y, 0, MAX_PAGE) &&
    within(viewport_w, 0, MAX_PAGE) &&
    viewport_w > 0 && { page_x, page_y, viewport_w };
  return {
    quote: (a.quote as string | undefined) ?? "",
    prefix: a.prefix as string | undefined,
    suffix: a.suffix as string | undefined,
    start_offset: offset(a.start_offset),
    end_offset: offset(a.end_offset),
    point: {
      ...(target ? { target: target as string } : {}),
      ...(path ? { path: path as string } : {}),
      ...(label ? { label: label as string } : {}),
      x,
      y,
      ...page,
    },
  };
}

// anchorLabel names what a thread or draft is on, for lists: the name of
// its pin's element, such as a section's heading, or else its quote, or the
// element's target.
export function anchorLabel(c: {
  selected_text?: string;
  anchor?: Partial<Anchor>;
}): string {
  const quote = (c.selected_text || c.anchor?.quote || "").trim();
  return c.anchor?.point?.label || quote || c.anchor?.point?.target || "";
}

// canMovePin tells whether a reader may move a thread's pin: its author may,
// and so may an editor of the document.
export function canMovePin(
  c: Pick<Comment, "anchor" | "author">,
  canEdit: boolean,
  reader?: Principal,
): boolean {
  return !!c.anchor?.point && (canEdit || samePrincipal(c.author, reader));
}

// initialsOf gives up to two initials of a name, for a pin's face.
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((word) => word[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}
