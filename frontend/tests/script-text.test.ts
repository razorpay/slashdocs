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
// SOURCE_ATTR, and script-owned inside contenteditable="false".
const source = {
  offsetOf: (el: Element) =>
    el.hasAttribute(SOURCE_ATTR) ? Number(el.getAttribute(SOURCE_ATTR)) : null,
  scriptOwned: (node: Node) =>
    !!(node as Element).closest?.('[contenteditable="false"]'),
};

let scriptText: ScriptText | null = null;
afterEach(() => {
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
  el("t").textContent = " Try it. ";
  expect(scriptText!.take()).toEqual([]);

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
  expect(hint.textContent).toContain("This text comes from a script.");
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

test("script text with elements in it shows the hint without a question", () => {
  const el = render(
    `<div ${SOURCE_ATTR}="0" contenteditable="false" id="t">Price: <b>7</b></div>`,
  );
  const post = start();
  el("t").click();
  expect(post).not.toHaveBeenCalled();
  expect(document.querySelector(".slashdocs-script-hint")).not.toBeNull();
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
  </script></body></html>`;
  const result = await probe(live, html, { at: 40, path: [1] }, [
    "Run it.",
    "Later",
    "Try it.",
  ]);
  observer.disconnect();
  expect(result).toEqual({ text: "Run it.", counts: [2, 1, 0] });
  expect(frames).toHaveLength(1);
  expect(frames[0].getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(frames[0].srcdoc).toContain(
    `<head><script id="slashdocs-bootstrap">window.slashdocs={kv:{}}</script></head>`,
  );
  expect(frames[0].isConnected).toBe(false);
});
