import { resolveAnchor } from "./anchoring/index.ts";
import type { CommentAnchor } from "./anchoring/types.ts";
import { expandToWholeInlines } from "./text-edit-range.ts";

const STYLE_ID = "slashdocs-edit-style";

function injectEditStyle(d: Document): void {
  if (d.getElementById(STYLE_ID)) return;
  const style = d.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    ".slashdocs-edited{background:#dcfce7;box-shadow:inset 0 -2px 0 #4ade80;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}[data-slashdocs-theme=dark] .slashdocs-edited{background:#14532d;box-shadow:inset 0 -2px 0 #22c55e}@media print{.slashdocs-edited{background:transparent!important;box-shadow:none!important}}";
  (d.head || d.documentElement).appendChild(style);
}

// Shows an unsaved edit in the rendered document. `html` is the app's sanitized
// replacement. Returns false when the anchored text is no longer there.
export function applyEditPreview(
  body: HTMLElement,
  anchor: CommentAnchor,
  html: string,
): boolean {
  const range = resolveAnchor(body, anchor);
  const grown = range && expandToWholeInlines(range);
  if (!grown) return false;
  const d = body.ownerDocument;
  injectEditStyle(d);
  const span = d.createElement("span");
  span.className = "slashdocs-edited";
  span.innerHTML = html;
  grown.deleteContents();
  grown.insertNode(span);
  return true;
}
