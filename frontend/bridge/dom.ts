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
  const [r, g, b] = paperOf(d);
  // The brightness of the color, from 0 to 255, with the sRGB weights.
  const surface = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
  if (d.documentElement.getAttribute("data-slashdocs-surface") !== surface)
    d.documentElement.setAttribute("data-slashdocs-surface", surface);
}

// paperOf gives the color of the page behind the document, as [r, g, b].
export function paperOf(d: Document): number[] {
  const view = d.defaultView;
  return (
    [d.body, d.documentElement]
      .map((el) => (el && view?.getComputedStyle(el).backgroundColor) || "")
      .map((color) =>
        /^rgba?\(/.test(color) ? color.match(/[\d.]+/g)!.map(Number) : [],
      )
      // A transparent background shows the one behind it.
      .find((rgba) => rgba.length >= 3 && rgba[3] !== 0) ?? [255, 255, 255]
  );
}

// The room that a control keeps clear of text on each side, and the distance
// between the points at which coversText looks for text.
const CLEAR_MARGIN = 4;
const CLEAR_STEP = 10;

// placeClear puts el, fixed in the viewport, at the first place where it
// covers none of lines and no text of d, with a margin of CLEAR_MARGIN around
// it. It tries places, as [left, top], then the sides of lines. When each
// place covers text, el stays near lines: at the first place that covers
// none of them, over other text. With dock, el also tries the bottom and the
// top of the viewport, and docks there when each place covers text. When el
// sits at an edge of the viewport, placeClear gives that edge.
export function placeClear(
  d: Document,
  el: HTMLElement,
  lines: DOMRect[],
  places: number[][],
  dock = false,
): "bottom" | "top" | null {
  const { width: viewWidth, height: viewHeight } = viewOf(d, true);
  const { offsetWidth: width, offsetHeight: height } = el;
  const span = lines.reduce(union, lines[0] ?? new DOMRect());
  const first = lines[0] ?? span;
  const beside = first.top + (first.height - height) / 2;
  const center = (viewWidth - width) / 2;
  const at = ([left, top]: number[]) =>
    DOMRect.fromRect({
      x: Math.max(8, Math.min(left, viewWidth - width - 8)),
      y: Math.max(8, Math.min(top, viewHeight - height - 8)),
      width,
      height,
    });
  const near = [
    ...places,
    [span.right + CLEAR_MARGIN * 2, beside],
    [span.left - CLEAR_MARGIN * 2 - width, beside],
  ].map(at);
  const edges = dock ? [at([center, viewHeight]), at([center, 0])] : [];
  const coversLines = (box: DOMRect) => lines.some((line) => overlap(box, line));
  // The hit test for text must not find el, so el waits out of the viewport.
  // It keeps its layout there, and so the focus of a field in it.
  el.style.setProperty("left", `${-width - viewWidth}px`, "important");
  const fallbacks = dock ? edges : near;
  const place =
    [...near, ...edges].find((box) => {
      const room = grow(box, CLEAR_MARGIN);
      return !coversLines(room) && !coversText(d, room);
    }) ??
    fallbacks.find((box) => !coversLines(box)) ??
    fallbacks[0];
  el.style.setProperty("left", `${place.left}px`, "important");
  el.style.setProperty("top", `${place.top}px`, "important");
  return place === edges[0] ? "bottom" : place === edges[1] ? "top" : null;
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
function coversText(d: Document, box: DOMRect): boolean {
  return textLines(d, box).length > 0;
}

// textLines gives the boxes of the lines of text of document d that overlap
// box, in the viewport. It finds the text near points on a grid of
// CLEAR_STEP, edges included, which finds every line of text and every word
// that is taller and wider than the step.
export function textLines(d: Document, box: DOMRect): DOMRect[] {
  const nodes = new Set<Node>();
  for (const y of steps(box.top, box.bottom))
    for (const x of steps(box.left, box.right)) {
      const node = caretRange(d, x, y)?.startContainer;
      if (node?.nodeType === Node.TEXT_NODE && node.textContent!.trim())
        nodes.add(node);
    }
  const words = d.createRange();
  return Array.from(nodes).flatMap((node) => {
    words.selectNodeContents(node);
    return Array.from(words.getClientRects()).filter((line) => overlap(box, line));
  });
}

// viewOf gives the viewport of document d without its scroll bars, and,
// when clear, without the bottom that the app covers, as a comment sheet does.
export function viewOf(d: Document, clear = false): DOMRect {
  const { clientWidth, clientHeight } = d.scrollingElement ?? d.documentElement;
  return new DOMRect(0, 0, clientWidth, clientHeight - (clear ? covered(d) : 0));
}

// covered gives how much of the bottom of the viewport of d the app covers.
export function covered(d: Document): number {
  return Number(d.getElementById(COVER)?.dataset.px) || 0;
}

const COVER = "slashdocs-cover";

// cover tells document d that the app covers the bottom px of its viewport,
// or none for 0. Its scroll padding then centers what comes into view above
// that part, and as much room after the page lets the end of the page come
// up above it.
export function cover(d: Document, px: number) {
  d.getElementById(COVER)?.remove();
  if (!(px > 0)) return;
  const style = d.createElement("style");
  style.id = COVER;
  style.dataset.px = String(px);
  style.setAttribute("data-slashdocs-injected", "");
  style.textContent = `html{scroll-padding-bottom:${px}px!important;padding-bottom:${px}px!important}`;
  d.head.appendChild(style);
}

// settled calls fn once the view stops scrolling, as at the end of a smooth
// scroll.
export function settled(view: Window, fn: () => void) {
  let last = NaN;
  let still = 0;
  const check = () => {
    still = view.scrollY === last ? still + 1 : 0;
    last = view.scrollY;
    if (still < 2) requestAnimationFrame(check);
    else fn();
  };
  requestAnimationFrame(check);
}

// holds tells whether box a holds all of box b.
export function holds(a: DOMRect, b: DOMRect): boolean {
  return (
    b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom
  );
}

// steps gives points from start to end, end included, at most CLEAR_STEP apart.
function steps(start: number, end: number): number[] {
  const count = Math.max(1, Math.ceil((end - start) / CLEAR_STEP));
  return Array.from(
    { length: count + 1 },
    (_, i) => start + ((end - start) * i) / count,
  );
}
