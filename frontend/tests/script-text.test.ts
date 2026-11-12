// @vitest-environment-options {"runScripts":"dangerously"}
import { afterEach, expect, test, vi } from "vitest";
import {
  EDIT_ATTR,
  find,
  locate,
  probe,
  startScriptText,
  withPrelude,
  type ScriptText,
} from "../bridge/script-text.ts";
import { SOURCE_ATTR } from "../bridge/source-pieces.ts";

// The source map of these tests: an element is original when it has
// SOURCE_ATTR, script-owned inside contenteditable="false", and fixed inside
// an svg.
const source = {
  offsetOf: (el: Element) =>
    el.hasAttribute(SOURCE_ATTR) ? Number(el.getAttribute(SOURCE_ATTR)) : null,
  scriptOwned: (node: Node) =>
    !!(node as Element).closest?.('[contenteditable="false"]:not(svg *)'),
  fixed: (node: Node) => !!(node as Element).closest?.("svg"),
};

let scriptText: ScriptText | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  scriptText?.stop();
  scriptText = null;
  document.body.innerHTML = "";
});

const onChange = vi.fn();

function start() {
  const post = vi.fn();
  scriptText = startScriptText(document, { source, post, onChange });
  return post;
}

function render(html: string) {
  document.body.innerHTML = html;
  return (id: string) => document.getElementById(id)!;
}

test("a locator counts element children from the nearest original element, without bridge elements", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="10"><mark class="slashdocs-mark">x</mark><p></p><p><span id="t">Save</span></p></div><b id="b"></b>`,
  );
  const locator = locate(el("t"), source.offsetOf);
  expect(locator).toEqual({ at: 10, path: [1, 0] });
  expect(find(document, locator!)).toBe(el("t"));
  expect(locate(el("b"), source.offsetOf)).toEqual({ at: null, path: [1] });
  expect(find(document, { at: null, path: [1] })).toBe(el("b"));
});

test("script text takes no keys and asks nothing while the reader comments, and keeps what they typed", async () => {
  const el = render(
    `<div ${SOURCE_ATTR}="20" contenteditable="false"><button id="t">Try it.</button><i id="u">Other</i></div>`,
  );
  const post = start();
  el("t").click();
  scriptText!.answer("script-1", true);
  el("t").textContent = "Run it.";
  scriptText!.setEditable(false);
  expect(el("t").hasAttribute("contenteditable")).toBe(false);
  el("u").click();
  expect(post).toHaveBeenCalledTimes(1);
  scriptText!.setEditable(true);
  expect(el("t").getAttribute("contenteditable")).toBe("true");
  expect(scriptText!.take()).toEqual([
    { locator: { at: 20, path: [0] }, before: "Try it.", after: "Run it." },
  ]);
});

test("a locator finds nothing when a script copied its original element", () => {
  render(
    `<div ${SOURCE_ATTR}="10"><i></i></div><div ${SOURCE_ATTR}="10"><i></i></div>`,
  );
  expect(find(document, { at: 10, path: [0] })).toBeNull();
  expect(find(document, { at: 99, path: [] })).toBeNull();
});

test("a click on script text asks the app, and its answer lets the reader type there", async () => {
  const el = render(
    `<p ${SOURCE_ATTR}="4">Plain</p><div ${SOURCE_ATTR}="20" contenteditable="false"><button id="t">Try it.</button></div>`,
  );
  const post = start();
  el("t").click();
  expect(post).toHaveBeenCalledWith({
    type: "slashdocs:script-text",
    requestId: "script-1",
    text: "Try it.",
    locator: { at: 20, path: [0] },
  });
  document.querySelector("p")!.click();
  expect(post).toHaveBeenCalledTimes(1);

  scriptText!.answer("script-0", true);
  expect(el("t").hasAttribute(EDIT_ATTR)).toBe(false);
  scriptText!.answer("script-1", true);
  expect(el("t").getAttribute("contenteditable")).toBe("true");
  expect(el("t").hasAttribute(EDIT_ATTR)).toBe(true);
  expect(document.activeElement).toBe(el("t"));
  expect(el("t").getAttribute("aria-description")).toBe(
    "A script on the page writes this text. You can change it here.",
  );

  el("t").textContent = "Run it.";
  await Promise.resolve();
  expect(onChange).toHaveBeenCalled();
  el("t").click();
  expect(post).toHaveBeenCalledTimes(1);
  expect(scriptText!.take()).toEqual([
    { locator: { at: 20, path: [0] }, before: "Try it.", after: "Run it." },
  ]);
  scriptText!.stop();
  expect(el("t").hasAttribute("contenteditable")).toBe(false);
  expect(el("t").hasAttribute(EDIT_ATTR)).toBe(false);
});

test("script text that no one string holds shows a hint that asks an agent", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><span id="t">Total: 7</span></div>`,
  );
  const post = start();
  el("t").click();
  scriptText!.answer("script-1", false);
  const hint = document.querySelector(".slashdocs-script-hint")!;
  expect(hint.getAttribute("contenteditable")).toBe("false");
  expect(hint.textContent).toContain("A script on the page writes this text.");
  hint.querySelector("button")!.click();
  expect(post).toHaveBeenLastCalledWith({
    type: "slashdocs:ask-agent",
    anchor: expect.objectContaining({ quote: "Total: 7" }),
  });
  expect(document.querySelector(".slashdocs-script-hint")).toBeNull();
});

test("the hint goes on Esc, on scroll and on a click elsewhere", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><span id="t">Total: 7</span></div><p id="p">x</p>`,
  );
  start();
  const showHint = (n: number) => {
    el("t").click();
    scriptText!.answer(`script-${n}`, false);
    return document.querySelector(".slashdocs-script-hint")!;
  };
  showHint(1).dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(document.querySelector(".slashdocs-script-hint")).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".slashdocs-script-hint")).toBeNull();
  showHint(2);
  document.dispatchEvent(new Event("scroll"));
  expect(document.querySelector(".slashdocs-script-hint")).toBeNull();
  showHint(3);
  el("p").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(document.querySelector(".slashdocs-script-hint")).toBeNull();
});

test("script text that shows in several places says so before the first key", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><b id="t">Needs review</b><b>Needs review</b><b> Needs review </b><b>Done</b></div>`,
  );
  start();
  el("t").click();
  scriptText!.answer("script-1", true);
  const note = document.querySelector(".slashdocs-script-hint")!;
  expect(note.textContent).toBe(
    "This text shows in 3 places. Your change goes to all of them.",
  );
  expect(el("t").getAttribute("aria-describedby")).toBe(note.id);
});

test("each entry into a place of a string that shows in several places says so again", async () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><b id="a">Needs review</b><b id="b">Needs review</b><b id="c">Needs review</b></div>`,
  );
  start();
  el("b").click();
  scriptText!.answer("script-1", true);
  el("b").textContent = "Needs reviewx";
  await Promise.resolve();
  scriptText!.replace("Needs review", "Needs reviewx");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".slashdocs-script-hint")).toBeNull();

  // The other place takes keys already, and says where they go.
  el("a").click();
  const note = document.querySelector(".slashdocs-script-hint")!;
  expect(note.textContent).toBe(
    "This text shows in 3 places. Your change goes to all of them.",
  );
  expect(el("a").getAttribute("aria-describedby")).toBe(note.id);
});

test("a failed check offers to try again", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><span id="t">Total: 7</span></div>`,
  );
  const post = start();
  el("t").click();
  scriptText!.answer("script-1", false, true);
  const hint = document.querySelector(".slashdocs-script-hint")!;
  expect(hint.textContent).toContain("Could not check this text.");
  hint.querySelector("button")!.click();
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "slashdocs:script-text", requestId: "script-2" }),
  );
});

test("a saved string shows its new text in every place that a script shows, and a hint pulses in place of a message", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><b id="t">Ready</b><b> Ready </b><b>Done</b></div><p ${SOURCE_ATTR}="90">Ready</p>`,
  );
  start();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(scriptText!.pulse()).toBe(false);
  const texts = scriptText!.replace("Ready", "Set");
  expect(texts).toHaveLength(2);
  expect(document.querySelector("div")!.textContent).toBe("Set Set Done");
  // The same text of the source is not the string.
  expect(document.querySelector("p")!.textContent).toBe("Ready");
  el("t").click();
  scriptText!.answer("script-1", false);
  expect(scriptText!.pulse()).toBe(true);
});

test("after a save, every place of the string takes keys, and the place typed in last gives the change", async () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false"><b id="a">Needs a look</b><b id="b">Needs a look</b><b id="c">Needs a look</b></div>`,
  );
  start();
  el("b").click();
  scriptText!.answer("script-1", true);
  el("b").textContent = "Needs a lookx";
  await Promise.resolve();
  scriptText!.replace("Needs a look", "Needs a lookx");
  expect(el("a").hasAttribute(EDIT_ATTR)).toBe(true);
  expect(el("c").getAttribute("contenteditable")).toBe("true");

  // Back to the loaded text in the place typed in: one change, which the
  // app saves and shows in the other places.
  el("b").firstChild!.textContent = "Needs a look";
  await Promise.resolve();
  const change = {
    locator: { at: 0, path: [1] },
    before: "Needs a look",
    after: "Needs a look",
  };
  expect(scriptText!.take()).toEqual([change]);
  scriptText!.replace("Needs a lookx", "Needs a look");
  expect(document.querySelector("div")!.textContent).toBe(
    "Needs a lookNeeds a lookNeeds a look",
  );

  // A key in another place gives its text as the change of the string.
  el("a").firstChild!.textContent = "Needs a lookq";
  await Promise.resolve();
  expect(scriptText!.take()).toEqual([{ ...change, after: "Needs a lookq" }]);
});

test("script text with elements in it shows the hint without a question", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false" id="t">Price: <b>7</b></div>`,
  );
  const post = start();
  el("t").click();
  expect(post).not.toHaveBeenCalled();
  expect(document.querySelector(".slashdocs-script-hint")).not.toBeNull();
});

test("fixed content shows its own hint without a question", () => {
  const el = render(
    `<p>See <svg ${SOURCE_ATTR}="0" contenteditable="false"><text id="t">Sales</text></svg></p>`,
  );
  const post = start();
  el("t").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(post).not.toHaveBeenCalled();
  expect(document.querySelector(".slashdocs-script-hint")).toHaveTextContent(
    "You cannot change this part of the page here.",
  );
});

test("the prelude goes where the server puts it", () => {
  const p = "<script>P</script>";
  expect(withPrelude("<!doctype html><html><HEAD lang=x><title>", p)).toBe(
    `<!doctype html><html><HEAD lang=x>${p}<title>`,
  );
  expect(withPrelude("<html><header></header>", p)).toBe(`<html>${p}<header></header>`);
  expect(withPrelude("<!DOCTYPE html><p>", p)).toBe(`<!DOCTYPE html>${p}<p>`);
  expect(withPrelude("<p>", p)).toBe(`${p}<p>`);
});

// jsdom does not load srcdoc, so this test writes a probe frame's srcdoc into
// its document when the frame joins the page. jsdom then runs its scripts.
test("a probe renders the html with the live prelude, measures it, and removes the frame", async () => {
  const live = document.createElement("iframe");
  live.setAttribute("sandbox", "allow-scripts allow-same-origin");
  live.srcdoc = `<!doctype html><html><head><script id="slashdocs-bootstrap">window.slashdocs={kv:{}}</script></head><body ${SOURCE_ATTR}="9"></body></html>`;
  document.body.append(live);
  const frames: HTMLIFrameElement[] = [];
  const observer = new MutationObserver((records) => {
    for (const { addedNodes } of records)
      for (const node of addedNodes) {
        if (node === live || !(node instanceof HTMLIFrameElement)) continue;
        frames.push(node);
        // The second script throws on purpose. The probe counts the error,
        // and the test takes it, so that jsdom does not print it.
        node.contentWindow!.addEventListener("error", (e) => e.preventDefault());
        node.contentDocument!.open();
        node.contentDocument!.write(node.srcdoc);
        node.contentDocument!.close();
      }
  });
  observer.observe(document.body, { childList: true });
  const html = `<!doctype html><html><head></head><body ${SOURCE_ATTR}="30"><ul ${SOURCE_ATTR}="40"></ul><script>
    const label = window.slashdocs ? "Run it." : "No prelude";
    for (let i = 0; i < 2; i++) document.querySelector("ul").append(Object.assign(document.createElement("li"), { textContent: label }));
    setTimeout(() => document.body.append(" Later "), 10);
  </script><script>missing.call();</script></body></html>`;
  const result = await probe(live, html, { at: 40, path: [1] }, [
    "Run it.",
    "Later",
    "Try it.",
  ]);
  observer.disconnect();
  // The texts are the two items, the late text and the code of the scripts.
  expect(result).toEqual({ text: "Run it.", counts: [2, 1, 0], texts: 5, errors: 1 });
  expect(frames).toHaveLength(1);
  expect(frames[0].getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(frames[0].srcdoc).toContain(`window.slashdocs={kv:{}}</script></head>`);
  expect(frames[0].isConnected).toBe(false);
});
