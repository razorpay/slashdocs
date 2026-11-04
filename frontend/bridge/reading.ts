// Book-mode reading helpers shared by the render bridge and the app. Pure, so
// they are unit tested in tests/reading.test.ts; bridge.ts only applies what
// they return.

export type ReaderSettings = {
  size: "s" | "m" | "l";
  width: "narrow" | "comfortable" | "wide";
  theme: "light" | "paper" | "system";
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  size: "m",
  width: "comfortable",
  theme: "system",
};

// Keys the bridge forwards to the reader, never while the reader is typing.
export const READER_KEYS = ["ArrowLeft", "ArrowRight", "t", "T", "/"] as const;

export type RestoreMethod = "quote" | "section" | "progression" | "none";

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
const DOT_CSS =
  'content:"";display:inline-block;width:.45em;height:.45em;border-radius:50%;background:#d97706;margin-right:.45em;vertical-align:middle';

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
// scroll is fully read.
export function progression(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const scrollable = scrollHeight - clientHeight;
  if (!(scrollable > 0)) return 1;
  const share = scrollTop / scrollable;
  if (!Number.isFinite(share)) return 0;
  return Math.min(1, Math.max(0, share));
}

export function readerSettingsCSS(s: ReaderSettings): string {
  const size = SIZES[s.size] ?? SIZES[DEFAULT_READER_SETTINGS.size];
  const width = WIDTHS[s.width] ?? WIDTHS[DEFAULT_READER_SETTINGS.width];
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

// A CSS string literal body: quotes and backslashes are escaped, and control
// characters (which would end the string) become hex escapes.
function cssString(value: string): string {
  let out = "";
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (c === '"' || c === "\\") out += `\\${c}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
    else out += c;
  }
  return out;
}

// A dot before each heading that changed since the reader last saw it.
export function changedHeadingsCSS(ids: string[]): string {
  return ids.map((id) => `[id="${cssString(id)}"]::before{${DOT_CSS}}`).join("");
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
