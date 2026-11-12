import { beforeAll, beforeEach, expect, test, vi } from "vitest";
// The editor takes only trusted input. See text-editing.test.ts.
// @ts-expect-error jsdom has no types for its wrappers.
import { implForWrapper } from "jsdom/lib/generated/idl/utils.js";

import { parseSource, tagSource } from "../src/lib/source-edits.ts";

// The bridge runs once, in a window that holds the frame of the document.
// Here that window is its own parent, so the test sees what the bridge
// posts to the app, and posts as the app does. The timers do not run: the
// bridge sets up the frame on one, and that is not a part of these tests.
let frame: HTMLIFrameElement;
let posted: { type: string; [key: string]: unknown }[] = [];
const fromApp = (data: object) =>
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  document.body.innerHTML = '<iframe id="slashdocs-doc"></iframe>';
  frame = document.querySelector("iframe")!;
  await import("../bridge/bridge.ts");
});
beforeEach(() => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((data) => void posted.push(data));
});

test("a user operation sends its draft in the same task, with no timer", async () => {
  const source = "<!doctype html>\n<html><body>\n<p>Hello world</p>\n</body></html>\n";
  const tagged = tagSource(await parseSource(source));
  const d = frame.contentDocument!;
  const view = frame.contentWindow as Window & typeof globalThis;
  d.replaceChild(
    d.importNode(
      new DOMParser().parseFromString(tagged, "text/html").documentElement,
      true,
    ),
    d.documentElement,
  );
  Object.defineProperty(frame, "srcdoc", { value: tagged });
  fromApp({ type: "slashdocs:text-editing", on: true });

  // Enter in the middle of the paragraph.
  d.getSelection()!.collapse(d.querySelector("p")!.firstChild, 5);
  const event = new view.InputEvent("beforeinput", {
    inputType: "insertParagraph",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "getTargetRanges", { value: () => [] });
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(d.body)._dispatch(impl);
  expect(d.querySelectorAll("p")).toHaveLength(2);

  // The draft is not in the operation, and it is before the next task: no
  // timer runs in this test.
  expect(posted).toEqual([]);
  await Promise.resolve();
  expect(posted[0]).toMatchObject({ type: "slashdocs:text-draft", edits: 1 });
  expect(posted[0].regions).toHaveLength(1);
});

test("a patch paints the highlights again only when it took one off", () => {
  const d = frame.contentDocument!;
  // jsdom has no layout: new text has no lines.
  const view = frame.contentWindow as Window & typeof globalThis;
  Object.assign(view.Range.prototype, { getClientRects: () => [] });
  const first = Number(d.querySelector("p")!.getAttribute("data-slashdocs-source"));
  const patch = (html: string) => {
    posted = [];
    fromApp({
      type: "slashdocs:text-patch",
      requestId: "r",
      edits: 1,
      patches: [{ in: first, after: null, before: null, html }],
    });
    expect(posted.at(-1)).toMatchObject({ type: "slashdocs:text-patched", ok: true });
    return posted.map(({ type }) => type);
  };
  // The comment is on the second paragraph, and the patch is in the first.
  // The paint waits for the take of the operation before.
  fromApp({ type: "slashdocs:paint", comments: [{ id: "c1", quote: "world" }] });
  expect(d.querySelector("mark.slashdocs-mark")).toBeNull();
  fromApp({ type: "slashdocs:text-collect", requestId: "t" });
  const mark = d.querySelector("mark.slashdocs-mark");
  expect(mark).toHaveTextContent("world");
  expect(patch("Hello there")).toEqual(["slashdocs:text-patched"]);
  expect(d.querySelector("mark.slashdocs-mark")).toBe(mark);

  fromApp({ type: "slashdocs:paint", comments: [{ id: "c2", quote: "Hello" }] });
  expect(patch("Hello, all")).toContain("slashdocs:paint-result");
  expect(d.querySelector("mark.slashdocs-mark")).toHaveTextContent("Hello");
});

test("a patch of a script string changes each place where a script shows it, or does not fit", () => {
  const d = frame.contentDocument!;
  Object.assign(frame.contentWindow!, { matchMedia: () => ({ matches: true }) });
  const made = d.createElement("b");
  made.textContent = "Ready";
  d.body.append(made);
  // The same text in the source is not the string.
  const own = d.querySelector("p")!;
  own.textContent = "Ready";
  const patch = (places: number) => {
    posted = [];
    fromApp({
      type: "slashdocs:text-patch",
      requestId: "r",
      edits: 1,
      patches: [{ script: 0, html: "", from: made.textContent, to: "Set", places }],
      flash: true,
    });
    return posted.at(-1);
  };
  expect(patch(1)).toMatchObject({ type: "slashdocs:text-patched", ok: true });
  expect([made.textContent, own.textContent]).toEqual(["Set", "Ready"]);
  // The app counted another number of places: the frame loads again.
  expect(patch(2)).toMatchObject({ type: "slashdocs:text-patched", ok: false });
});
