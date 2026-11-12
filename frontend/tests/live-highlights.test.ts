import { beforeAll, beforeEach, expect, test, vi } from "vitest";
// The editor takes only trusted input. See text-editing.test.ts.
// @ts-expect-error jsdom has no types for its wrappers.
import { implForWrapper } from "jsdom/lib/generated/idl/utils.js";

import { describeAnchor } from "../bridge/anchoring/index.ts";
import { parseSource, tagSource } from "../src/lib/source-edits.ts";

// Every patch changes all of the view, so a patch that asks is withdrawn.
vi.mock("../bridge/view.ts", async (original) => ({
  ...(await original<typeof import("../bridge/view.ts")>()),
  watchView: () => ({ settle: () => 1, restore() {} }),
}));

// A comment highlight stays on its characters while other people change the
// text live, as the caret does. See bridge.test.ts for the harness: the
// window of the bridge is its own parent.
let frame: HTMLIFrameElement;
let d: Document;
let posted: { type: string; [key: string]: unknown }[] = [];
const fromApp = (data: object) =>
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  document.body.innerHTML = '<iframe id="slashdocs-doc"></iframe>';
  frame = document.querySelector("iframe")!;
  await import("../bridge/bridge.ts");
  const source = `<!doctype html>
<html><body>
<p id="a">Ten kilo lima mike november.</p>
<p id="b">Eleven kilo lima mike november.</p>
<p id="c">Twelve kilo lima mike november.</p>
<p id="d">Typing here LONG-OFFLINE hotel and MORE-OFFLINE india.</p>
</body></html>
`;
  const tagged = tagSource(await parseSource(source));
  d = frame.contentDocument!;
  d.replaceChild(
    d.importNode(
      new DOMParser().parseFromString(tagged, "text/html").documentElement,
      true,
    ),
    d.documentElement,
  );
  Object.defineProperty(frame, "srcdoc", { value: tagged });
  // jsdom has no layout: new text has no lines.
  const view = frame.contentWindow as Window & typeof globalThis;
  Object.assign(view.Range.prototype, { getClientRects: () => [] });
});
beforeEach(() => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((data) => void posted.push(data));
});

// comment gives a comment on the text of an element, as the app sends it.
function comment(id: string, element: string, quote: string) {
  const node = d.getElementById(element)!.firstChild as Text;
  const range = d.createRange();
  range.setStart(node, node.data.indexOf(quote));
  range.setEnd(node, node.data.indexOf(quote) + quote.length);
  return { id, anchor: describeAnchor(d.body, range) };
}

const sourceOf = (element: string) =>
  Number(d.getElementById(element)!.getAttribute("data-slashdocs-source"));

// patch shows the new content of an element as the app sends it, and gives
// the results of the paint after it.
function patch(element: string, html: string, edits = 0) {
  posted = [];
  fromApp({
    type: "slashdocs:text-patch",
    requestId: "r",
    edits,
    patches: [
      {
        in: sourceOf(element),
        after: null,
        before: null,
        html,
      },
    ],
  });
  expect(posted.at(-1)).toMatchObject({ type: "slashdocs:text-patched", ok: true });
  return posted.find(({ type }) => type === "slashdocs:paint-result")?.results;
}

const marks = (id: string) =>
  Array.from(d.querySelectorAll(`mark.slashdocs-mark[data-cid="${id}"]`));
const marked = (id: string) => ({
  in: marks(id).map((m) => m.closest("p")!.id),
  text: marks(id)
    .map((m) => m.textContent)
    .join(""),
});

test("a highlight on a repeated phrase grows, shrinks, and detaches with its own text", () => {
  const items = [comment("c1", "b", "kilo lima mike")];
  fromApp({ type: "slashdocs:paint", comments: items });
  expect(marked("c1")).toEqual({ in: ["b"], text: "kilo lima mike" });

  // Typing in the phrase makes the highlight grow. The phrase is still in
  // the paragraphs around it, but the highlight does not go there.
  expect(patch("b", "Eleven kilo liXXma mike november.")).toEqual([
    { id: "c1", anchored: true },
  ]);
  expect(marked("c1")).toEqual({ in: ["b"], text: "kilo liXXma mike" });

  // A deletion in it makes it shrink.
  patch("b", "Eleven kilo mike november.");
  expect(marked("c1")).toEqual({ in: ["b"], text: "kilo mike" });

  // When all of its text goes, the comment is detached, and a paint of the
  // same comments does not anchor it on another copy.
  expect(patch("b", "Eleven november.")).toEqual([{ id: "c1", anchored: false }]);
  expect(marks("c1")).toEqual([]);
  posted = [];
  fromApp({ type: "slashdocs:paint", comments: items, active: "c1" });
  expect(posted.at(-1)).toMatchObject({ results: [{ id: "c1", anchored: false }] });
  expect(marks("c1")).toEqual([]);
});

test("a draft gives the anchor of the text that its highlight holds after a patch", () => {
  const draft = comment("draft:1", "c", "kilo lima mike");
  fromApp({ type: "slashdocs:paint", comments: [draft] });
  patch("c", "Twelve kilo lima INSIDE mike november.");
  posted = [];
  fromApp({ type: "slashdocs:anchor", requestId: "q", id: "draft:1" });
  expect(posted).toEqual([
    {
      type: "slashdocs:anchor-result",
      requestId: "q",
      anchor: {
        dom_path: "body",
        quote: "kilo lima INSIDE mike",
        prefix: expect.stringMatching(/Twelve $/),
        suffix: expect.stringMatching(/^ november\./),
        start_offset: draft.anchor!.start_offset,
        end_offset: draft.anchor!.end_offset! + 7,
      },
    },
  ]);
  // A comment with no highlight has no anchor.
  posted = [];
  fromApp({ type: "slashdocs:anchor", requestId: "q", id: "draft:2" });
  expect(posted).toEqual([
    { type: "slashdocs:anchor-result", requestId: "q", anchor: null },
  ]);
  patch("c", "Twelve kilo lima mike november.");
});

test("a comment whose unique word goes is detached, and not on a similar word", () => {
  const items = [comment("c2", "d", "LONG-OFFLINE")];
  fromApp({ type: "slashdocs:paint", comments: items });
  expect(marked("c2")).toEqual({ in: ["d"], text: "LONG-OFFLINE" });

  expect(patch("d", "Typing here hotel and MORE-OFFLINE india.")).toEqual([
    { id: "c2", anchored: false },
  ]);
  expect(d.querySelector("mark.slashdocs-mark")).toBeNull();
});

test("a withdrawn patch leaves a held highlight on its text", () => {
  const items = [comment("c3", "a", "lima")];
  fromApp({ type: "slashdocs:paint", comments: items });
  expect(marked("c3")).toEqual({ in: ["a"], text: "lima" });
  posted = [];
  fromApp({
    type: "slashdocs:text-patch",
    requestId: "r",
    edits: 0,
    ask: true,
    patches: [{ in: sourceOf("a"), after: null, before: null, html: "Ten november." }],
  });
  expect(posted.at(-1)).toMatchObject({ ok: false, withdrawn: true });
  expect(d.getElementById("a")).toHaveTextContent("Ten kilo lima mike november.");
  expect(marked("c3")).toEqual({ in: ["a"], text: "lima" });
});

test("a highlight stays on its word when Enter splits the paragraph before it", () => {
  const items = [comment("c4", "c", "november")];
  fromApp({ type: "slashdocs:paint", comments: items });
  fromApp({ type: "slashdocs:text-editing", on: true });
  const node = d.getElementById("c")!.firstChild as Text;
  // The caret is before the space before the highlight.
  expect(node.data).toBe("Twelve kilo lima mike ");
  d.getSelection()!.collapse(node, node.length - 1);
  const view = frame.contentWindow as Window & typeof globalThis;
  const event = new view.InputEvent("beforeinput", {
    inputType: "insertParagraph",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "getTargetRanges", { value: () => [] });
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(d.body)._dispatch(impl);
  fromApp({ type: "slashdocs:text-collect", requestId: "t" });
  expect(marks("c4")).toHaveLength(1);
  expect(marks("c4")[0]).toHaveTextContent("november");
  expect(marks("c4")[0].closest("p")!.textContent).toBe("\u00a0november.");
});

// type types text after the first copy of after in an element, as the
// browser does when the editor lets it, and gives the count of user
// operations that the draft after it tells.
async function type(element: string, after: string, text: string) {
  const el = d.getElementById(element)!;
  let offset = el.textContent!.indexOf(after) + after.length;
  const walker = d.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text;
  while (offset > node.length) {
    offset -= node.length;
    node = walker.nextNode() as Text;
  }
  d.getSelection()!.collapse(node, offset);
  const view = frame.contentWindow as Window & typeof globalThis;
  const event = new view.InputEvent("beforeinput", {
    inputType: "insertText",
    data: text,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "getTargetRanges", { value: () => [] });
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(d.body)._dispatch(impl);
  // The highlights came off, so the caret is in another node now.
  const caret = d.getSelection()!;
  const at = caret.focusNode as Text;
  const place = caret.focusOffset;
  at.insertData(place, text);
  caret.collapse(at, place + text.length);
  d.body.dispatchEvent(new view.Event("input", { bubbles: true }));
  await Promise.resolve();
  const drafts = posted.filter(({ type }) => type === "slashdocs:text-draft");
  return drafts.at(-1)!.edits as number;
}

test("a comment that comes back with the anchor that the server moved keeps its highlight", async () => {
  fromApp({ type: "slashdocs:text-editing", on: true });
  fromApp({
    type: "slashdocs:paint",
    comments: [comment("c5", "a", "kilo lima mike")],
  });
  await type("a", "kilo li", "XX");
  // The highlights come back with the take of the typing.
  fromApp({ type: "slashdocs:text-collect", requestId: "t" });
  expect(marked("c5")).toEqual({ in: ["a"], text: "kilo liXXma mike" });

  // The server moved the anchor over the typing, as the highlight did. The
  // highlight shows that text already, so it stays as it is: it does not
  // flash or move.
  posted = [];
  fromApp({ type: "slashdocs:anchor", requestId: "a", id: "c5" });
  const { anchor } = posted.find(({ type }) => type === "slashdocs:anchor-result")!;
  expect(anchor).toMatchObject({ quote: "kilo liXXma mike" });
  const [mark] = marks("c5");
  posted = [];
  fromApp({ type: "slashdocs:paint", comments: [{ id: "c5", anchor }] });
  expect(posted.at(-1)).toMatchObject({ results: [{ id: "c5", anchored: true }] });
  expect(marks("c5")).toEqual([mark]);
});
