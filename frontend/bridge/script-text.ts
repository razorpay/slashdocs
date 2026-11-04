import { describeAnchor, snapToWords } from "./anchoring/index.ts";
import type { SourceMap } from "./source-map.ts";
import { SOURCE_ATTR, type Locator, type ScriptChange } from "./source-pieces.ts";

// Script text is text that a document's own script shows. The editor cannot
// save it from the page, because the script writes it again on every load.
// When the reader clicks it, the bridge asks the app whether one string in
// the source holds it. If so, the reader can type there, and the app writes
// the new text into that string. If not, a hint offers to ask an agent.

// The parts of the source map that script text uses.
export type ScriptSource = Pick<SourceMap, "offsetOf" | "scriptOwned">;

export interface ScriptText {
  // Takes the app's answer to a slashdocs:script-text request.
  answer(requestId: string, editable: boolean): void;
  // The script text that the reader changed since editing started. A
  // change of white space at the ends only does not count.
  take(): ScriptChange[];
  stop(): void;
}

// EDIT_ATTR marks script text that the reader can type in. The editor takes
// only plain text there and leaves it out of its regions.
export const EDIT_ATTR = "data-slashdocs-script-edit";

const HINT_GAP = 6;

// The bridge's own elements carry a slashdocs- class or id, or are marked as
// injected. A locator skips them, so that it finds the same element in a page
// without them.
const BRIDGE_OWNED =
  "[class^='slashdocs-'],[class*=' slashdocs-'],[id^='slashdocs-'],[data-slashdocs-injected]";
const bridgeOwned = (el: Element) => el.matches(BRIDGE_OWNED);

function children(el: Element): Element[] {
  return [...el.children].filter((child) => !bridgeOwned(child));
}

// locate gives the locator of el: the nearest original element at or above
// it, and the child indexes from there down to el.
export function locate(
  el: Element,
  offsetOf: ScriptSource["offsetOf"],
): Locator | null {
  const path: number[] = [];
  for (let at: Element = el; ;) {
    const offset = offsetOf(at);
    if (offset !== null) return { at: offset, path };
    if (at === at.ownerDocument.body) return { at: null, path };
    const parent = at.parentElement;
    if (!parent) return null;
    path.unshift(children(parent).indexOf(at));
    at = parent;
  }
}

// find gives the element at locator in d, or null when no element or more
// than one element has its offset.
export function find(d: Document, { at, path }: Locator): Element | null {
  const start = at === null ? [d.body] : d.querySelectorAll(`[${SOURCE_ATTR}="${at}"]`);
  let el: Element | null = start.length === 1 ? start[0] : null;
  for (const index of path) el = el ? (children(el)[index] ?? null) : null;
  return el;
}

export function startScriptText(
  d: Document,
  {
    source,
    post,
    onChange,
  }: {
    source: ScriptSource;
    post: (message: object) => void;
    // The reader changed script text.
    onChange: () => void;
  },
): ScriptText {
  let requests = 0;
  let asked: { requestId: string; el: Element; locator: Locator } | null = null;
  // The script text that the reader can type in: its locator, its text
  // before the first key, and the contenteditable value it had.
  const edits = new Map<
    Element,
    { locator: Locator; before: string; was: string | null }
  >();
  let hint: HTMLElement | null = null;
  const typing = new MutationObserver(onChange);

  // ask starts at the element of the clicked or focused text. The bridge's
  // own wrappers, such as comment highlights, are not that element.
  function ask(ev: Event): void {
    const target = ev.target as Node;
    if (hint?.contains(target)) return;
    let el =
      target.nodeType === Node.ELEMENT_NODE
        ? (target as Element)
        : target.parentElement;
    while (el && bridgeOwned(el)) el = el.parentElement;
    if (!el || el.closest(`[${EDIT_ATTR}]`)) return;
    if (!source.scriptOwned(el) || !el.textContent?.trim()) return;
    const locator = locate(el, source.offsetOf);
    if (!locator) return;
    dismissHint();
    // Plain text replaces all of an element's children, so an element with
    // elements in it gets the hint without a question.
    if (children(el).length) return showHint(el);
    asked = { requestId: `script-${++requests}`, el, locator };
    post({
      type: "slashdocs:script-text",
      requestId: asked.requestId,
      text: el.textContent,
      locator,
    });
  }

  function answer(requestId: string, editable: boolean): void {
    if (asked?.requestId !== requestId) return;
    const { el, locator } = asked;
    asked = null;
    if (!el.isConnected) return;
    if (!editable) return showHint(el);
    edits.set(el, {
      locator,
      before: el.textContent ?? "",
      was: el.getAttribute("contenteditable"),
    });
    el.setAttribute("contenteditable", "true");
    el.setAttribute(EDIT_ATTR, "");
    typing.observe(el, { characterData: true, childList: true, subtree: true });
    (el as HTMLElement).focus();
    d.getSelection()?.collapse(el, el.childNodes.length);
  }

  function showHint(el: Element): void {
    const range = d.createRange();
    range.selectNodeContents(el);
    const anchor = describeAnchor(d.body, snapToWords(range));
    hint = d.createElement("div");
    hint.className = "slashdocs-script-hint";
    hint.setAttribute("contenteditable", "false");
    hint.setAttribute("data-slashdocs-injected", "");
    hint.setAttribute("role", "note");
    const text = d.createElement("span");
    text.textContent = "This text comes from a script.";
    hint.append(text);
    if (anchor) {
      const button = d.createElement("button");
      button.type = "button";
      button.textContent = "Ask an agent to change this";
      button.addEventListener("click", () => {
        post({ type: "slashdocs:ask-agent", anchor });
        dismissHint();
      });
      hint.append(button);
    }
    injectStyle();
    d.body.append(hint);
    // The hint sits below the text, or above it when there is no room below.
    const rect = el.getBoundingClientRect();
    const view = d.defaultView!;
    const below = rect.bottom + HINT_GAP;
    const top =
      below + hint.offsetHeight <= view.innerHeight
        ? below
        : rect.top - HINT_GAP - hint.offsetHeight;
    const left = Math.min(rect.left, view.innerWidth - hint.offsetWidth - 8);
    hint.style.setProperty("top", `${Math.max(8, top)}px`, "important");
    hint.style.setProperty("left", `${Math.max(8, left)}px`, "important");
  }

  function dismissHint(): void {
    hint?.remove();
    hint = null;
  }

  function injectStyle(): void {
    if (d.getElementById("slashdocs-script-hint-style")) return;
    const style = d.createElement("style");
    style.id = "slashdocs-script-hint-style";
    style.textContent = `
      .slashdocs-script-hint{all:initial!important;position:fixed!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:8px!important;padding:6px 6px 6px 12px!important;border-radius:10px!important;background:#fff!important;color:#52525b!important;box-shadow:0 0 0 1px #0001,0 4px 16px #0002!important;font:13px/1.4 system-ui,sans-serif!important}
      .slashdocs-script-hint span{all:initial!important;color:inherit!important;font:inherit!important}
      .slashdocs-script-hint button{all:initial!important;padding:6px 10px!important;border-radius:8px!important;background:#f4f4f5!important;color:#18181b!important;font:500 13px/1 system-ui,sans-serif!important;cursor:pointer!important}
      .slashdocs-script-hint button:hover{background:#e4e4e7!important}
      .slashdocs-script-hint button:focus-visible{outline:2px solid #6366f1!important;outline-offset:-2px!important}
      [data-slashdocs-theme=dark] .slashdocs-script-hint{background:#27272a!important;color:#d4d4d8!important;box-shadow:0 0 0 1px #fff2,0 4px 16px #0004!important}
      [data-slashdocs-theme=dark] .slashdocs-script-hint button{background:#3f3f46!important;color:#fff!important}
      @media print{.slashdocs-script-hint{display:none!important}}`;
    d.head.append(style);
  }

  const onPointerDown = (ev: Event) => {
    if (!hint?.contains(ev.target as Node)) dismissHint();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") dismissHint();
  };
  d.addEventListener("click", ask, true);
  d.addEventListener("focusin", ask, true);
  d.addEventListener("pointerdown", onPointerDown, true);
  d.addEventListener("keydown", onKey, true);
  d.addEventListener("scroll", dismissHint, true);

  return {
    answer,
    take: () =>
      [...edits]
        .map(([el, { locator, before }]) => ({
          locator,
          before,
          after: el.textContent ?? "",
        }))
        // The app trims the text, so a change at the ends only is no change.
        .filter(({ before, after }) => before.trim() !== after.trim()),
    stop() {
      d.removeEventListener("click", ask, true);
      d.removeEventListener("focusin", ask, true);
      d.removeEventListener("pointerdown", onPointerDown, true);
      d.removeEventListener("keydown", onKey, true);
      d.removeEventListener("scroll", dismissHint, true);
      dismissHint();
      typing.disconnect();
      for (const [el, { was }] of edits) {
        el.removeAttribute(EDIT_ATTR);
        if (was === null) el.removeAttribute("contenteditable");
        else el.setAttribute("contenteditable", was);
      }
    },
  };
}

// What a probe frame shows at a locator, and how many of its text nodes,
// trimmed, equal each of the given strings.
export type ProbeResult = { text: string | null; counts: number[] };

// The prelude is the first script of every render. The server puts it in
// before any document script runs, so document code that calls
// window.slashdocs finds it. [/] keeps the end of a script element out of
// the bridge, which the wrapper page holds in a script element.
const PRELUDE = /<script id="slashdocs-bootstrap">[\s\S]*?<[/]script>/;

// A document can render text in a timer or after a promise once it loads.
// 100 ms takes in that work and keeps a save quick.
const SETTLE_MS = 100;
// A probe that does not load in this time measures what it has, so that a
// slow resource does not hold the save.
const LOAD_LIMIT_MS = 5000;

// probe renders html as the live frame renders a document: in a hidden frame
// of the same width and height, with the same sandbox and prelude. It waits
// for the load, two animation frames and SETTLE_MS, measures, and removes
// the frame.
export async function probe(
  live: HTMLIFrameElement,
  html: string,
  locator: Locator,
  strings: string[],
): Promise<ProbeResult> {
  const wrapper = live.ownerDocument;
  const view = wrapper.defaultView!;
  const frame = wrapper.createElement("iframe");
  frame.setAttribute("sandbox", live.getAttribute("sandbox") ?? "");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:0;top:0;width:${live.clientWidth}px;height:${live.clientHeight}px;border:0;visibility:hidden;pointer-events:none`;
  frame.srcdoc = withPrelude(html, live.srcdoc.match(PRELUDE)?.[0] ?? "");
  const wait = (ms: number) => new Promise((resolve) => view.setTimeout(resolve, ms));
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
  wrapper.body.append(frame);
  try {
    await Promise.race([loaded, wait(LOAD_LIMIT_MS)]);
    for (let i = 0; i < 2; i++)
      await new Promise((resolve) => view.requestAnimationFrame(resolve));
    await wait(SETTLE_MS);
    return measure(frame.contentDocument, locator, strings);
  } finally {
    frame.remove();
  }
}

function measure(d: Document | null, locator: Locator, strings: string[]): ProbeResult {
  const counts = strings.map(() => 0);
  if (!d?.body) return { text: null, counts };
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue!.trim();
    for (const [i, s] of strings.entries()) if (s.trim() === text) counts[i]++;
  }
  return { text: find(d, locator)?.textContent ?? null, counts };
}

// withPrelude puts prelude into html where the server puts it: right after
// the head start tag, else the html start tag, else the doctype, else first.
export function withPrelude(html: string, prelude: string): string {
  const at = [/<head[>/ \t\n\r\f]/i, /<html[>/ \t\n\r\f]/i, /<!doctype/i]
    .map((tag) => html.search(tag))
    .map((start) => (start < 0 ? -1 : html.indexOf(">", start) + 1))
    .find((end) => end > 0);
  return at === undefined
    ? prelude + html
    : html.slice(0, at) + prelude + html.slice(at);
}
