// Small DOM helpers that several bridge modules share.

// isEditableTarget tells whether a key at target, or else at the focused
// element, types into document d: a text field, focused editable content, or
// a document in design mode. The bridge's own shortcuts leave such keys
// alone. The document editor's body types only while it has the caret, as in
// Google Docs: after Esc blurs it, the shortcuts work again.
export function isEditableTarget(d: Document, target: EventTarget | null): boolean {
  if (d.designMode.toLowerCase() === "on") return true;
  const node = (target ?? d.activeElement) as Node | null;
  const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  const editable = el?.closest?.(
    "input,textarea,select,[contenteditable],[role='textbox']",
  );
  if (!editable) return false;
  if (editable.hasAttribute("contenteditable"))
    return (
      editable.getAttribute("contenteditable")?.toLowerCase() !== "false" &&
      editable.matches(":focus-within")
    );
  if (editable.localName !== "input") return true;
  const type = (editable.getAttribute("type") || "text").toLowerCase();
  return !/^(button|checkbox|radio|submit|reset|file|image|color|range|hidden)$/.test(
    type,
  );
}

// caretRange gives a collapsed range at the text position nearest a point in
// the viewport, or null where the browser finds none.
export function caretRange(d: Document, x: number, y: number): Range | null {
  if (!d.caretPositionFromPoint) return d.caretRangeFromPoint?.(x, y) ?? null;
  const position = d.caretPositionFromPoint(x, y);
  if (!position) return null;
  const range = d.createRange();
  range.setStart(position.offsetNode, position.offset);
  return range;
}

// reducedMotion tells whether the reader of document d asks for less motion.
export function reducedMotion(d: Document | null | undefined): boolean {
  return !!d?.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// scrollBehavior gives a smooth scroll, or an instant one for a reader who
// asks for less motion.
export function scrollBehavior(d: Document | null | undefined): ScrollBehavior {
  return reducedMotion(d) ? "instant" : "smooth";
}

// blockOf gives the nearest ancestor laid out as a block, such as a paragraph
// or list item.
export function blockOf(node: Node): Element | null {
  let element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const view = node.ownerDocument?.defaultView;
  while (element && view) {
    if (!view.getComputedStyle(element).display.startsWith("inline")) return element;
    element = element.parentElement;
  }
  return element;
}

// markSurface sets data-slashdocs-surface on the document element to "dark"
// or "light", from the background that the document shows behind its text:
// the background of the body, else of the html element, else white. The
// bridge's controls in the document take their colors from it.
export function markSurface(d: Document) {
  const view = d.defaultView;
  const [r, g, b] = [d.body, d.documentElement]
    .map((el) => (el && view?.getComputedStyle(el).backgroundColor) || "")
    .map((color) => (/^rgba?\(/.test(color) ? color.match(/[\d.]+/g)!.map(Number) : []))
    // A transparent background shows the one behind it.
    .find((rgba) => rgba.length >= 3 && rgba[3] !== 0) ?? [255, 255, 255];
  // The brightness of the color, from 0 to 255, with the sRGB weights.
  const surface = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
  if (d.documentElement.getAttribute("data-slashdocs-surface") !== surface)
    d.documentElement.setAttribute("data-slashdocs-surface", surface);
}

// The room that a control keeps clear of text on each side, and the distance
// between the points at which coversText looks for text.
const CLEAR_MARGIN = 4;
const CLEAR_STEP = 10;

// placeClear puts el, fixed in the viewport, at the first place where it
// covers none of lines and no text of d, with a margin of CLEAR_MARGIN around
// it. It tries places, as [left, top], then the sides of lines, then the
// bottom and the top of the viewport. When each place covers text, el sits at
// the bottom or the top of the viewport, where it covers none of lines.
export function placeClear(
  d: Document,
  el: HTMLElement,
  lines: DOMRect[],
  places: number[][],
): void {
  const view = d.defaultView!;
  const { offsetWidth: width, offsetHeight: height } = el;
  const span = lines.reduce(union, lines[0] ?? new DOMRect());
  const first = lines[0] ?? span;
  const beside = first.top + (first.height - height) / 2;
  const center = (view.innerWidth - width) / 2;
  const edges = [
    [center, view.innerHeight],
    [center, 0],
  ];
  const boxes = [
    ...places,
    [span.right + CLEAR_MARGIN * 2, beside],
    [span.left - CLEAR_MARGIN * 2 - width, beside],
    ...edges,
  ].map(([left, top]) =>
    DOMRect.fromRect({
      x: Math.max(8, Math.min(left, view.innerWidth - width - 8)),
      y: Math.max(8, Math.min(top, view.innerHeight - height - 8)),
      width,
      height,
    }),
  );
  const coversLines = (box: DOMRect) => lines.some((line) => overlap(box, line));
  // The hit test for text skips el, so that el does not hide the text under
  // it. el keeps its layout, and so the focus of a field in it.
  el.style.setProperty("pointer-events", "none", "important");
  const [bottom, top] = boxes.slice(-edges.length);
  const place =
    boxes.find((box) => {
      const room = grow(box, CLEAR_MARGIN);
      return !coversLines(room) && !coversText(d, room);
    }) ?? (coversLines(bottom) ? top : bottom);
  el.style.removeProperty("pointer-events");
  el.style.setProperty("left", `${place.left}px`, "important");
  el.style.setProperty("top", `${place.top}px`, "important");
}

function union(a: DOMRect, b: DOMRect): DOMRect {
  const [left, top] = [Math.min(a.left, b.left), Math.min(a.top, b.top)];
  return new DOMRect(
    left,
    top,
    Math.max(a.right, b.right) - left,
    Math.max(a.bottom, b.bottom) - top,
  );
}

function grow(box: DOMRect, by: number): DOMRect {
  return new DOMRect(box.x - by, box.y - by, box.width + by * 2, box.height + by * 2);
}

function overlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// coversText tells whether box, in the viewport, covers text of document d.
// It tests points on a grid of CLEAR_STEP, edges included, which finds every
// line of text and every word that is taller and wider than the step.
function coversText(d: Document, box: DOMRect): boolean {
  const words = d.createRange();
  for (const y of steps(box.top, box.bottom)) {
    for (const x of steps(box.left, box.right)) {
      const node = caretRange(d, x, y)?.startContainer;
      if (node?.nodeType !== Node.TEXT_NODE || !node.textContent!.trim()) continue;
      words.selectNodeContents(node);
      const at = DOMRect.fromRect({ x, y });
      if (Array.from(words.getClientRects()).some((line) => overlap(at, line)))
        return true;
    }
  }
  return false;
}

// steps gives points from start to end, end included, at most CLEAR_STEP apart.
function steps(start: number, end: number): number[] {
  const count = Math.max(1, Math.ceil((end - start) / CLEAR_STEP));
  return Array.from(
    { length: count + 1 },
    (_, i) => start + ((end - start) * i) / count,
  );
}
