import { dispatchPublicEvent } from "./public-names.ts";

// Snapshot live DOM, rather than reloading the stored HTML and losing its state.
export async function snapshotForPrint(d: Document): Promise<string> {
  const view = d.defaultView!;
  const pending: Promise<unknown>[] = [];
  let accepting = true;
  dispatchPublicEvent(view, "beforeprint", {
    detail: {
      waitUntil: (work: Promise<unknown>) => {
        if (accepting) pending.push(Promise.resolve(work));
      },
    },
  });
  accepting = false;
  view.dispatchEvent(new Event("beforeprint"));
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  // A handler is optional. Rejections and timeouts still produce a snapshot.
  const copy = d.documentElement.cloneNode(true) as HTMLElement;
  const original = Array.from(d.documentElement.querySelectorAll("*"));
  const cloned = Array.from(copy.querySelectorAll("*"));
  for (let index = 0; index < original.length; index++) {
    const source = original[index];
    const target = cloned[index];
    if (source.tagName === "INPUT") {
      const input = source as HTMLInputElement;
      // Never copy password or file input values into an export.
      target.setAttribute(
        "value",
        /^(password|file)$/i.test(input.type) ? "" : input.value,
      );
      target.toggleAttribute("checked", input.checked);
    } else if (source.tagName === "TEXTAREA")
      target.textContent = (source as HTMLTextAreaElement).value;
    else if (source.tagName === "OPTION")
      target.toggleAttribute("selected", (source as HTMLOptionElement).selected);
    else if (source.tagName === "CANVAS") {
      try {
        const image = d.createElement("img");
        image.src = (source as HTMLCanvasElement).toDataURL();
        image.style.cssText = (source as HTMLElement).style.cssText;
        image.width = source.clientWidth;
        image.height = source.clientHeight;
        target.replaceWith(image);
      } catch {
        /* Cross-origin canvases cannot be read by the browser. */
      }
    }
    for (const attribute of ["src", "href", "poster"]) {
      const value = target.getAttribute(attribute);
      if (value && !value.startsWith("#")) {
        try {
          target.setAttribute(attribute, new URL(value, d.baseURI).href);
        } catch {
          target.removeAttribute(attribute);
        }
      }
    }
    // Preserve the selected image from responsive image sets.
    if (source.tagName === "IMG" && (source as HTMLImageElement).currentSrc) {
      target.setAttribute("src", (source as HTMLImageElement).currentSrc);
      target.removeAttribute("srcset");
    }
    const style = view.getComputedStyle(source);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      source.scrollHeight > source.clientHeight
    ) {
      const element = target as HTMLElement;
      element.style.setProperty("overflow", "visible", "important");
      element.style.setProperty("height", "auto", "important");
      element.style.setProperty("max-height", "none", "important");
    }
  }
  copy
    .querySelectorAll(
      ".slashdocs-selection-action,.slashdocs-heading-link,.slashdocs-text-flash,#slashdocs-dark-style,script",
    )
    .forEach((node) => node.remove());
  return "<!doctype html>" + copy.outerHTML;
}
