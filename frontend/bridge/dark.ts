// Dark mode for documents that do not follow the theme. The app asks for a
// dark document; the bridge sends the dark theme first, and a document that
// still paints a light page is inverted. Media are inverted back, so photos
// and diagrams keep their colors.

export const DARK_STYLE_ID = "slashdocs-dark-style";

const INVERT = "invert(1) hue-rotate(180deg)";

// parseColor reads the rgb() or rgba() a computed style returns.
export function parseColor(value: string): [number, number, number, number] | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!m) return null;
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

// pageBackground is the color the reader sees behind the text: the first
// opaque background of body or html, or null for a transparent page.
export function pageBackground(d: Document): [number, number, number] | null {
  const view = d.defaultView;
  for (const el of [d.body, d.documentElement]) {
    if (!el || !view) continue;
    const color = parseColor(view.getComputedStyle(el).backgroundColor);
    if (color && color[3] > 0.5) return [color[0], color[1], color[2]];
  }
  return null;
}

export function isLight([r, g, b]: [number, number, number]): boolean {
  // Relative luminance, without gamma: enough to tell paper from ink.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

// isLightPage tells whether the document paints a light page. A transparent
// page is light when its text is dark: it was written for white paper.
export function isLightPage(d: Document): boolean {
  const background = pageBackground(d);
  if (background) return isLight(background);
  const view = d.defaultView;
  const text = view && d.body && parseColor(view.getComputedStyle(d.body).color);
  return !text || !isLight([text[0], text[1], text[2]]);
}

export function darkStyle(background: [number, number, number]): string {
  // The page color is set on the root so the inverted canvas is painted too,
  // also for a page that leaves it to the frame, which is dark meanwhile.
  const [r, g, b] = background;
  return (
    `html{filter:${INVERT}!important;background-color:rgb(${r},${g},${b})!important}` +
    `img,video,canvas,iframe,embed,object,svg image,[style*="background-image"]{filter:${INVERT}!important}` +
    `@media print{html,img,video,canvas,iframe,embed,object,svg image,[style*="background-image"]{filter:none!important}}`
  );
}

// applyDark inverts a light document, or removes the inversion. It returns
// whether the document is now inverted.
export function applyDark(d: Document, on: boolean): boolean {
  const existing = d.getElementById(DARK_STYLE_ID);
  existing?.remove();
  if (!on) return false;
  // Judge the document's own colors, without a previous inversion.
  if (!isLightPage(d)) return false;
  const style = d.createElement("style");
  style.id = DARK_STYLE_ID;
  style.textContent = darkStyle(pageBackground(d) || [255, 255, 255]);
  (d.head || d.documentElement).appendChild(style);
  return true;
}
