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
