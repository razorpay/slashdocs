// Book-mode reading helpers shared by the render bridge and the app. Pure, so
// they are unit tested in tests/reading.test.ts; bridge.ts only applies what
// they return.

// The allowed reader settings, listed once: the bridge maps them to CSS and
// the app's settings store validates saved values against them.
export const READER_SIZES = ["s", "m", "l"] as const;
export const READER_WIDTHS = ["narrow", "comfortable", "wide"] as const;
export const READER_THEMES = ["light", "paper", "system"] as const;

export type ReaderSettings = {
  size: (typeof READER_SIZES)[number];
  width: (typeof READER_WIDTHS)[number];
  theme: (typeof READER_THEMES)[number];
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  size: "m",
  width: "comfortable",
  theme: "system",
};

// Keys the bridge forwards to the reader, never while the reader is typing.
export const READER_KEYS = ["ArrowLeft", "ArrowRight", "t", "T", "/"] as const;

// How a position restore landed, as position-restored reports it.
export const RESTORE_METHODS = ["quote", "section", "progression", "none"] as const;
export type RestoreMethod = (typeof RESTORE_METHODS)[number];

// Zoom scales px-sized text too, which a root font-size would not.
const SIZES: Record<ReaderSettings["size"], string> = {
  s: "0.9375",
  m: "1",
  l: "1.125",
};
const WIDTHS: Record<ReaderSettings["width"], string> = {
  narrow: "60ch",
  comfortable: "72ch",
  wide: "none",
};
const PAPER_CSS = "html{background:#f8f4ea}body{background:transparent}";

// The last heading whose top is at or above the probe, or "" before the first.
export function sectionAt(
  headings: { id: string; top: number }[],
  probeTop: number,
): string {
  let section = "";
  for (const heading of headings) {
    if (heading.top > probeTop) break;
    section = heading.id;
  }
  return section;
}

// How far through the page the reader is, from 0 to 1. A page that does not
// scroll gives null: being on it says nothing about having read to its end.
export function progression(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number | null {
  const scrollable = scrollHeight - clientHeight;
  if (!(scrollable > 0)) return null;
  const share = scrollTop / scrollable;
  if (!Number.isFinite(share)) return 0;
  return Math.min(1, Math.max(0, share));
}

export type ScrollBox = { top: number; height: number; client: number };

// Progression in the first box that scrolls: the page, then any nested
// scroller (app-style chapters scroll an inner container, never the page).
// Null when nothing scrolls, so the chapter fits on screen.
export function scrollProgression(boxes: (ScrollBox | null)[]): number | null {
  for (const box of boxes) {
    if (!box) continue;
    const p = progression(box.top, box.height, box.client);
    if (p !== null) return p;
  }
  return null;
}

export function readerSettingsCSS(s: ReaderSettings): string {
  // Own keys only: settings arrive by message, and "constructor" is not a size.
  const size =
    SIZES[Object.hasOwn(SIZES, s.size) ? s.size : DEFAULT_READER_SETTINGS.size];
  const width =
    WIDTHS[Object.hasOwn(WIDTHS, s.width) ? s.width : DEFAULT_READER_SETTINGS.width];
  const body = `body{zoom:${size};max-width:${width};margin-inline:auto}`;
  return s.theme === "paper" ? body + PAPER_CSS : body;
}

// The theme the document renders in. Light and paper override a dark app
// for the document only; system follows the app.
export function documentTheme(
  setting: ReaderSettings["theme"] | undefined,
  appTheme: "light" | "dark",
): "light" | "dark" {
  return setting === "light" || setting === "paper" ? "light" : appTheme;
}

// A dot at the start of each heading that changed since the reader last saw
// it. The dot is an element of its own, so a document's heading ::before
// (section numbers, icons) is left alone.
export const CHANGE_DOT_CLASS = "slashdocs-change-dot";
export const CHANGE_DOT_CSS = `.${CHANGE_DOT_CLASS}{display:inline-block!important;width:.45em!important;height:.45em!important;margin:0 .45em 0 0!important;padding:0!important;border:0!important;border-radius:50%!important;background:#d97706!important;vertical-align:middle!important}@media print{.${CHANGE_DOT_CLASS}{display:none!important}}`;
const HEADING = /^H[1-6]$/;

// The heading ids from a mark-headings message: at most 1000 non-empty
// strings of at most 1024 characters.
export function markedHeadingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 1000)
    .filter((id): id is string => typeof id === "string" && !!id && id.length <= 1024);
}

// Leaves exactly one dot in each listed heading and none elsewhere.
export function applyChangeDots(d: Document, ids: string[]): void {
  const want = new Set(ids);
  d.querySelectorAll(`.${CHANGE_DOT_CLASS}`).forEach((dot) => {
    // A dot that a document script moved, or a second one, goes too.
    const heading = dot.parentElement;
    if (!heading || !want.has(heading.id) || heading.firstElementChild !== dot) {
      dot.remove();
    }
  });
  for (const id of want) {
    const heading = d.getElementById(id);
    if (!heading || !HEADING.test(heading.tagName)) continue;
    if (heading.firstElementChild?.classList.contains(CHANGE_DOT_CLASS)) continue;
    const dot = d.createElement("span");
    dot.className = CHANGE_DOT_CLASS;
    dot.setAttribute("aria-hidden", "true");
    heading.prepend(dot);
  }
}

// The order position restore tries: the quote, then its section, then the
// scroll share. Progression 0 is the top, which needs no restore.
export function restoreMethod(input: {
  quoteResolved: boolean;
  sectionExists: boolean;
  progression: number | null;
}): RestoreMethod {
  if (input.quoteResolved) return "quote";
  if (input.sectionExists) return "section";
  const p = input.progression;
  if (p !== null && p > 0 && p <= 1) return "progression";
  return "none";
}
