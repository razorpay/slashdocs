import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["strong", "b", "em", "i", "code", "br", "a"];

// DOMPurify reports the document wrapper it parses into as removed.
const WRAPPERS = new Set(["HTML", "HEAD", "BODY"]);

export function sanitizeInline(html: string): { html: string; dropped: boolean } {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    FORBID_CONTENTS: ["script", "style", "template", "noscript"],
  });
  const dropped = DOMPurify.removed.some(
    (item) => !("element" in item) || !WRAPPERS.has(item.element.nodeName),
  );
  return { html: clean, dropped };
}

export function inlineText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const br of Array.from(template.content.querySelectorAll("br"))) {
    br.replaceWith(" ");
  }
  return template.content.textContent ?? "";
}
