// A box in the viewport.
export type Rect = { left: number; top: number; width: number; height: number };

const GAP = 8;
// A placed box keeps this far from the edges of its bounds.
export const EDGE = 12;

// placeBeside puts a box of the given size next to an anchor, inside bounds:
// to its right, else to its left, with its top level with the anchor's, or
// else under or over it, as for a highlight as wide as the page.
export function placeBeside(
  anchor: Rect,
  size: { width: number; height: number },
  bounds: Rect,
): { x: number; y: number } {
  const min = { x: bounds.left + EDGE, y: bounds.top + EDGE };
  const max = {
    x: bounds.left + bounds.width - EDGE - size.width,
    y: bounds.top + bounds.height - EDGE - size.height,
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const right = anchor.left + anchor.width + GAP;
  const left = anchor.left - GAP - size.width;
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - size.height;
  if (right <= max.x || left >= min.x)
    return { x: right <= max.x ? right : left, y: clamp(anchor.top, min.y, max.y) };
  return {
    x: clamp(anchor.left, min.x, max.x),
    y: clamp(below <= max.y || above < min.y ? below : above, min.y, max.y),
  };
}
