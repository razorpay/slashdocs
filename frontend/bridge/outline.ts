// The outline is the list of headings the app shows beside the document, as a
// table of contents. The bridge gives every heading an id first, so each entry
// can be navigated to.

export interface OutlineHeading {
  id: string;
  level: number;
  text: string;
}

// Bounds the message: the app treats it as untrusted input.
export const MAX_OUTLINE_HEADINGS = 500;
export const MAX_OUTLINE_TEXT = 200;

// Bridge controls such as the heading link button are not part of the text.
const BRIDGE_CONTROLS = ".slashdocs-heading-link";

function headingText(heading: Element): string {
  const copy = heading.cloneNode(true) as Element;
  copy.querySelectorAll(BRIDGE_CONTROLS).forEach((node) => node.remove());
  return (copy.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_OUTLINE_TEXT);
}

// collectOutline lists the headings with an id and text, in document order.
// Headings inside hidden elements are left out: they are not part of what
// the reader can go to.
export function collectOutline(d: Document): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (const heading of Array.from(d.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (headings.length >= MAX_OUTLINE_HEADINGS) break;
    if (!heading.id || heading.closest("[hidden],[aria-hidden='true']")) continue;
    const text = headingText(heading);
    if (!text) continue;
    headings.push({ id: heading.id, level: Number(heading.tagName[1]), text });
  }
  return headings;
}

// activeHeading is the last heading at or above the top of the viewport, or
// the first heading when the reader has not scrolled past any.
// At the end of the page the last headings can never reach the top, so the
// last heading in view is active instead.
export function activeHeading(
  d: Document,
  headings: OutlineHeading[],
  offset = 80,
): string {
  const view = d.defaultView;
  const scroller = d.scrollingElement;
  const atEnd =
    !!view &&
    !!scroller &&
    scroller.scrollTop > 0 &&
    scroller.scrollTop + view.innerHeight >= scroller.scrollHeight - 2;
  const limit = atEnd ? view!.innerHeight : offset;
  let active = headings[0]?.id || "";
  for (const item of headings) {
    const el = d.getElementById(item.id);
    if (!el || !el.getClientRects().length) continue;
    if (el.getBoundingClientRect().top > limit) break;
    active = item.id;
  }
  return active;
}

export function sameOutline(a: OutlineHeading[], b: OutlineHeading[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) => x.id === b[i].id && x.level === b[i].level && x.text === b[i].text,
    )
  );
}
