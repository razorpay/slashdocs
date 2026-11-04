import type { Anchor, AnchorPoint } from "@/api";

// Point comments ("pins"): comments on a spot in an element instead of on
// selected text. See AnchorPoint.

export type PointAnchor = Partial<Anchor> & { point: AnchorPoint };

const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;
const PATH = /^(\d{1,5}(\.\d{1,5}){0,63})?$/;
const MAX_LABEL = 128;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const fraction = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const optionalText = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length <= max);

// parsePointAnchor accepts a point anchor from the render frame, which also
// runs the document's own scripts, and keeps only the fields the API takes.
export function parsePointAnchor(value: unknown): PointAnchor | null {
  const a = (value ?? {}) as Record<string, unknown>;
  const p = (a.point ?? {}) as Record<string, unknown>;
  const { target, path, label, x, y } = p;
  if (
    !fraction(x) ||
    !fraction(y) ||
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
    },
  };
}

// anchorLabel names what a thread or draft is on, for lists: its quote, or
// else the element of its pin.
export function anchorLabel(c: {
  selected_text?: string;
  anchor?: Partial<Anchor>;
}): string {
  const quote = (c.selected_text || c.anchor?.quote || "").trim();
  return quote || c.anchor?.point?.label || c.anchor?.point?.target || "";
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
