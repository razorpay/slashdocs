import DOMPurify from "dompurify";

export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
// Allow a full-size upload plus DOM and print-preparation markup.
export const MAX_PRINT_CHARACTERS = 60 * 1024 * 1024;

export function downloadFilename(value: unknown): string {
  if (typeof value !== "string") throw new Error("A filename is required.");
  // Treat names as names, never paths. Remove control and direction overrides.
  const name = value
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex -- Filenames must not contain control bytes.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 160);
  if (!name) throw new Error("A filename is required.");
  return name;
}

export function printDocumentHTML(html: string): string {
  if (html.length > MAX_PRINT_CHARACTERS)
    throw new Error("This document is too large to print.");
  const root = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ["link"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta"],
    FORBID_ATTR: ["autofocus", "srcdoc", "action", "formaction", "ping"],
  });
  if (!(root instanceof HTMLElement)) throw new Error("Invalid print document.");
  root.querySelectorAll("link").forEach((link) => {
    if (link.rel !== "stylesheet") link.remove();
  });
  const head = root.querySelector("head")!;
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'self'; script-src 'none'; style-src 'unsafe-inline' https: http:; img-src https: http: data: blob:; font-src https: http: data:; media-src https: http: data: blob:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'";
  head.prepend(policy);
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  head.prepend(referrer);
  const style = document.createElement("style");
  style.textContent =
    "html,body{height:auto!important;max-height:none!important;overflow:visible!important}.slashdocs-selection-action,.slashdocs-heading-link,.slashdocs-svg-mark-rect{display:none!important}.slashdocs-mark{background:transparent!important;box-shadow:none!important;color:inherit!important;-webkit-text-fill-color:inherit!important}";
  head.append(style);
  return "<!doctype html>" + root.outerHTML;
}

export function openPrintPreview(): {
  show(html: string, title: string, done: () => void): void;
  close(): void;
} {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("Allow popups to print this document.");
  popup.opener = null;
  popup.document.title = "Print document";
  const status = popup.document.createElement("p");
  status.textContent = "Preparing your document…";
  status.style.cssText = "font:14px system-ui;padding:16px;color:#52525b";
  popup.document.body.append(status);
  return {
    close: () => popup.close(),
    show(html, title, done) {
      if (popup.closed) {
        done();
        return;
      }
      const safeHTML = printDocumentHTML(html);
      popup.document.title = title.slice(0, 200) || "Print document";
      status.remove();
      popup.document.body.style.cssText = "margin:0;background:#f4f4f5";
      const button = popup.document.createElement("button");
      button.textContent = "Print / Save as PDF";
      button.style.cssText =
        "display:block;margin:12px auto;padding:10px 16px;border:0;border-radius:8px;background:#4f46e5;color:white;font:14px system-ui;cursor:pointer";
      const frame = popup.document.createElement("iframe");
      frame.title = "Print preview";
      // Scripts stay disabled even if sanitization misses active markup.
      frame.setAttribute("sandbox", "allow-same-origin allow-modals");
      frame.style.cssText =
        "display:block;border:0;width:100%;height:calc(100vh - 68px);background:white";
      frame.srcdoc = safeHTML;
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          done();
        }
      };
      const print = () => {
        if (popup.closed) {
          finish();
          return;
        }
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } finally {
          finish();
        }
      };
      button.onclick = print;
      frame.onload = async () => {
        frame.onload = null;
        // Give images and fonts a bounded chance to settle before pagination.
        await Promise.race([
          Promise.allSettled([
            frame.contentDocument?.fonts.ready,
            ...Array.from(frame.contentDocument?.images || []).map((image) =>
              image.decode().catch(() => undefined),
            ),
          ]),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        print();
      };
      popup.addEventListener("pagehide", finish, { once: true });
      popup.document.body.append(button, frame);
    },
  };
}
