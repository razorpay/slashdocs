import { describeAnchor, snapToWords } from "./anchoring/index.ts";
import { placeClear, reducedMotion } from "./dom.ts";
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
  // Takes the app's answer to a slashdocs:script-text request: whether the
  // reader may type in the text, and whether the app could not check it.
  answer(requestId: string, editable: boolean, failed?: boolean): void;
  // Draws the eye to the hint that shows, and tells whether one shows.
  pulse(): boolean;
  // Shows to in every place of the page that shows from, as a load of the
  // saved source would, and gives the texts that changed. The reader can
  // then type in each of those places.
  replace(from: string, to: string): Text[];
  // Each script string that the reader typed in since editing started, with
  // its text at the start and its text now, which can be the same again.
  take(): ScriptChange[];
  stop(): void;
}

// EDIT_ATTR marks script text that the reader can type in. The editor takes
// only plain text there and leaves it out of its regions.
export const EDIT_ATTR = "data-slashdocs-script-edit";

const HINT_GAP = 6;
const HINT_ID = "slashdocs-script-hint";
// The highlight that marks the other places of a string.
const SAME_TEXT = "slashdocs-same-text";
// Text in these elements does not show on the page.
const NOT_SHOWN = "script,style,template,noscript,title";
// The sentence for script text that cannot change here. The app says the
// same when there is no hint.
const SCRIPT_WRITES = "A script on the page writes this text.";
// What a screen reader says about script text that the reader can change.
const EDITABLE = "A script on the page writes this text. You can change it here.";

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
  // The script text that the reader can type in: the locator and the text
  // before the first key of its string, the contenteditable value it had,
  // and when the reader last typed there. The places of one string share
  // the locator of the place that the app checked.
  type Edit = { locator: Locator; before: string; was: string | null; typed: number };
  const edits = new Map<Element, Edit>();
  let keys = 0;
  // The hint or note that shows at script text, and that text.
  let hint: { box: HTMLElement; el: Element } | null = null;
  const typing = new MutationObserver((records) => {
    for (const { target } of records) {
      const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentNode;
      const place = (el as Element | null)?.closest(`[${EDIT_ATTR}]`);
      const edit = place && edits.get(place);
      if (edit) edit.typed = ++keys;
    }
    onChange();
  });

  // ask starts at the element of the clicked or focused text. The bridge's
  // own wrappers, such as comment highlights, are not that element.
  function ask(ev: Event): void {
    const target = ev.target as Node;
    if (hint?.box.contains(target)) return;
    let el =
      target.nodeType === Node.ELEMENT_NODE
        ? (target as Element)
        : target.parentElement;
    while (el && bridgeOwned(el)) el = el.parentElement;
    if (!el || hint?.el === el) return;
    // The reader can type in this place already: each entry says again
    // where a change goes.
    const place = el.closest(`[${EDIT_ATTR}]`);
    if (place) {
      if (hint?.el !== place) noteOthers(place);
      return;
    }
    if (!source.scriptOwned(el) || !el.textContent?.trim()) return;
    askAbout(el);
  }

  function askAbout(el: Element): void {
    const locator = locate(el, source.offsetOf);
    if (!locator) return;
    dismissHint();
    // Plain text replaces all of an element's children, so an element with
    // elements in it gets the hint without a question.
    if (children(el).length) return readOnlyHint(el);
    asked = { requestId: `script-${++requests}`, el, locator };
    post({
      type: "slashdocs:script-text",
      requestId: asked.requestId,
      text: el.textContent,
      locator,
    });
  }

  // answer takes the app's answer: the reader may type in the text, may
  // not, or the app could not check it.
  function answer(requestId: string, editable: boolean, failed = false): void {
    if (asked?.requestId !== requestId) return;
    const { el, locator } = asked;
    asked = null;
    if (!el.isConnected) return;
    if (failed)
      return showHint(el, "Could not check this text.", "Try again", () =>
        askAbout(el),
      );
    if (!editable) return readOnlyHint(el);
    allowTyping(el, { locator, before: el.textContent ?? "" });
    noteOthers(el);
    (el as HTMLElement).focus();
    d.getSelection()?.collapse(el, el.childNodes.length);
  }

  // A change goes to every place that shows the same string, so when there
  // are others, a note at el says so before the first key, and marks them.
  function noteOthers(el: Element): void {
    const others = textsShowing(el.textContent ?? "").filter((t) => !el.contains(t));
    if (!others.length) return;
    showHint(
      el,
      `This text shows in ${others.length + 1} places. Your change goes to all of them.`,
    );
    mark(others);
  }

  // allowTyping lets the reader type in el, a place of the string at
  // locator, and names it as script text that they can change.
  function allowTyping(el: Element, edit: Pick<Edit, "locator" | "before">): void {
    edits.set(el, { ...edit, was: el.getAttribute("contenteditable"), typed: 0 });
    el.setAttribute("contenteditable", "true");
    el.setAttribute(EDIT_ATTR, "");
    el.setAttribute("aria-description", EDITABLE);
    typing.observe(el, { characterData: true, childList: true, subtree: true });
  }

  function readOnlyHint(el: Element): void {
    const range = d.createRange();
    range.selectNodeContents(el);
    const anchor = describeAnchor(d.body, snapToWords(range));
    showHint(
      el,
      SCRIPT_WRITES,
      anchor ? "Ask an agent to change this" : undefined,
      () => post({ type: "slashdocs:ask-agent", anchor }),
    );
  }

  // showHint puts a note at the text, with a button when action is given.
  // The text names the note, and Tab from the text goes to the button.
  function showHint(
    el: Element,
    message: string,
    action?: string,
    onAction?: () => void,
  ) {
    dismissHint();
    const box = d.createElement("div");
    box.className = "slashdocs-script-hint";
    box.id = HINT_ID;
    box.setAttribute("contenteditable", "false");
    box.setAttribute("data-slashdocs-injected", "");
    box.setAttribute("role", "note");
    const text = d.createElement("span");
    text.textContent = message;
    box.append(text);
    if (action) {
      const button = d.createElement("button");
      button.type = "button";
      button.textContent = action;
      button.addEventListener("click", () => {
        dismissHint();
        onAction?.();
      });
      box.append(button);
    }
    injectStyle();
    d.body.append(box);
    fitLines(text);
    el.setAttribute("aria-describedby", HINT_ID);
    hint = { box, el };
    place(box, el);
  }

  // fitLines makes text as wide as its widest line. CSS sizes a box to the
  // text in one line, and so leaves room after balanced lines.
  function fitLines(text: HTMLElement): void {
    const range = d.createRange();
    range.selectNodeContents(text);
    const lines = [...(range.getClientRects?.() ?? [])];
    if (lines.length < 2) return;
    const widest = Math.max(...lines.map((line) => line.width));
    text.style.setProperty("width", `${Math.ceil(widest)}px`, "important");
  }

  function dismissHint(): void {
    if (!hint) return;
    const { box, el } = hint;
    hint = null;
    el.removeAttribute("aria-describedby");
    unmark();
    const out = box.animate?.([{ opacity: 0, transform: "scale(.97)" }], {
      duration: reducedMotion(d) ? 0 : 100,
      easing: "ease-in",
    });
    if (out) out.onfinish = () => box.remove();
    else box.remove();
  }

  // pulse draws the eye to the hint of the text that the reader tried to
  // change, and tells whether one shows.
  function pulse(): boolean {
    if (!hint) return false;
    if (!reducedMotion(d))
      hint.box.animate?.(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.04)" },
          { transform: "scale(1)" },
        ],
        { duration: 240, easing: "ease-out" },
      );
    return true;
  }

  // textsShowing gives the texts of the page that show text, trimmed, as a
  // probe counts them.
  function textsShowing(text: string): Text[] {
    const wanted = text.trim();
    const found: Text[] = [];
    if (!wanted) return found;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest(NOT_SHOWN) && node.nodeValue!.trim() === wanted)
        found.push(node as Text);
    }
    return found;
  }

  // The other places of a string are marked with a highlight, which does
  // not change the DOM. Browsers without highlights show the note only.
  const view = d.defaultView as (Window & typeof globalThis) | null;
  function mark(texts: Text[]): void {
    if (!view?.CSS?.highlights) return;
    const ranges = texts.map((t) => {
      const range = d.createRange();
      range.selectNodeContents(t);
      return range;
    });
    view.CSS.highlights.set(SAME_TEXT, new view.Highlight(...ranges));
  }
  function unmark(): void {
    view?.CSS?.highlights?.delete(SAME_TEXT);
  }

  function injectStyle(): void {
    if (d.getElementById("slashdocs-script-hint-style")) return;
    const style = d.createElement("style");
    style.id = "slashdocs-script-hint-style";
    style.textContent = `
      .slashdocs-script-hint{all:initial!important;position:fixed!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:8px!important;max-width:min(360px,calc(100vw - 16px))!important;box-sizing:border-box!important;padding:6px 6px 6px 12px!important;border-radius:10px!important;background:#fff!important;color:#52525b!important;box-shadow:0 0 0 1px #0001,0 4px 16px #0002!important;font:13px/1.4 system-ui,sans-serif!important;transform-origin:top left!important;animation:slashdocs-hint-in .15s ease-out!important}
      @keyframes slashdocs-hint-in{from{opacity:0;transform:scale(.97)}}
      .slashdocs-script-hint span{all:initial!important;color:inherit!important;font:inherit!important;text-wrap:balance!important}
      .slashdocs-script-hint button{all:initial!important;flex:none!important;padding:6px 10px!important;border-radius:8px!important;background:#f4f4f5!important;color:#18181b!important;font:500 13px/1 system-ui,sans-serif!important;cursor:pointer!important}
      .slashdocs-script-hint button:hover{background:#e4e4e7!important}
      .slashdocs-script-hint button:focus-visible{outline:2px solid #6366f1!important;outline-offset:-2px!important}
      ::highlight(${SAME_TEXT}){text-decoration:underline 2px rgba(234,179,8,.9);text-underline-offset:3px}
      [data-slashdocs-surface=dark] .slashdocs-script-hint{background:#27272a!important;color:#d4d4d8!important;box-shadow:0 0 0 1px #fff2,0 4px 16px #0004!important}
      [data-slashdocs-surface=dark] .slashdocs-script-hint button{background:#3f3f46!important;color:#fff!important}
      @media(prefers-reduced-motion:reduce){.slashdocs-script-hint{animation:none!important}}
      @media print{.slashdocs-script-hint{display:none!important}}`;
    d.head.append(style);
  }

  const onPointerDown = (ev: Event) => {
    if (!hint?.box.contains(ev.target as Node)) dismissHint();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") dismissHint();
    const button = hint?.box.querySelector("button");
    if (
      ev.key === "Tab" &&
      !ev.shiftKey &&
      button &&
      hint?.el.contains(d.activeElement)
    ) {
      ev.preventDefault();
      button.focus();
    }
  };
  d.addEventListener("click", ask, true);
  d.addEventListener("focusin", ask, true);
  d.addEventListener("pointerdown", onPointerDown, true);
  d.addEventListener("keydown", onKey, true);
  d.addEventListener("scroll", dismissHint, true);

  return {
    answer,
    pulse,
    replace(from, to) {
      const texts = textsShowing(from);
      // The string of the place that the reader typed in.
      const edit =
        texts.map((t) => edits.get(t.parentElement!)).find(Boolean) ??
        [...edits].find(([el]) => el.textContent?.trim() === to.trim())?.[1];
      for (const t of texts) {
        const data = t.data;
        const lead = data.slice(0, data.length - data.trimStart().length);
        t.data = lead + to.trim() + data.slice(data.trimEnd().length);
        // The other places are the same string, so the reader can type there
        // too, and the next save changes every place again.
        const el = t.parentElement!;
        if (edit && !edits.has(el)) allowTyping(el, edit);
      }
      // New text empties the marks of the other places, so they mark again.
      if (view?.CSS?.highlights?.has(SAME_TEXT))
        mark(textsShowing(to).filter((t) => !hint?.el.contains(t)));
      return texts;
    },
    // The places of one string give one change: the text of the place that
    // the reader typed in last.
    take: () => {
      const strings = new Map<string, Edit & { el: Element }>();
      for (const [el, edit] of edits) {
        // A script can replace the element: its text is then not the reader's.
        if (!el.isConnected) continue;
        const key = JSON.stringify(edit.locator);
        if (edit.typed >= (strings.get(key)?.typed ?? -1))
          strings.set(key, { ...edit, el });
      }
      return [...strings.values()].map(({ locator, before, el }) => ({
        locator,
        before,
        after: el.textContent ?? "",
      }));
    },
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
        el.removeAttribute("aria-description");
        if (was === null) el.removeAttribute("contenteditable");
        else el.setAttribute("contenteditable", was);
      }
    },
  };

  // place puts the hint where it covers no text: above the text, below
  // it, or beside it.
  function place(box: HTMLElement, el: Element): void {
    const lines = Array.from(el.getClientRects());
    const first = lines[0] ?? el.getBoundingClientRect();
    const last = lines.at(-1) ?? first;
    const { offsetHeight: height } = box;
    placeClear(d, box, lines, [
      [first.left, first.top - HINT_GAP - height],
      [last.left, last.bottom + HINT_GAP],
      [last.right + HINT_GAP, last.top + (last.height - height) / 2],
    ]);
  }
}

// What a probe frame shows at a locator, how many of its text nodes, trimmed,
// equal each of the given strings, how many text nodes show text, and how
// many errors its scripts threw.
export type ProbeResult = {
  text: string | null;
  counts: number[];
  texts: number;
  errors: number;
};

// The prelude is the first script of every render. The server puts it in
// before any document script runs, so document code that calls
// window.slashdocs finds it. [/] keeps the end of a script element out of
// the bridge, which the wrapper page holds in a script element.
const PRELUDE = /<script id="slashdocs-bootstrap">[\s\S]*?<[/]script>/;
// The probe counts the errors of the document's scripts from the start of
// the prelude.
const COUNT_ERRORS =
  "var slashdocsProbeErrors=0;" +
  "addEventListener('error',function(){slashdocsProbeErrors++});" +
  "addEventListener('unhandledrejection',function(){slashdocsProbeErrors++});";

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
  const prelude = live.srcdoc.match(PRELUDE)?.[0] ?? "";
  frame.srcdoc = withPrelude(
    html,
    prelude.replace(/^<script[^>]*>/, `$&${COUNT_ERRORS}`),
  );
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
  const errors =
    (d?.defaultView as { slashdocsProbeErrors?: number } | null)
      ?.slashdocsProbeErrors ?? 0;
  if (!d?.body) return { text: null, counts, texts: 0, errors };
  let texts = 0;
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue!.trim();
    if (text) texts++;
    for (const [i, s] of strings.entries()) if (s.trim() === text) counts[i]++;
  }
  return { text: find(d, locator)?.textContent ?? null, counts, texts, errors };
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
