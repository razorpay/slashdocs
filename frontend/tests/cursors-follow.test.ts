import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  caretLine,
  caretOffset,
  createCursorLayer,
  trackPointer,
} from "../bridge/cursors.ts";

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout: every point is on a tall body.
  document.elementFromPoint = () => document.body;
  vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 4000),
  );
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

test("a follow before the first view keeps waiting, and follows that view", () => {
  const unfollowed = vi.fn();
  const layer = createCursorLayer(() => document, unfollowed);
  const moves: unknown[] = [];
  window.addEventListener("slashdocs:follow", (e) => {
    e.preventDefault();
    moves.push((e as CustomEvent).detail);
  });

  layer.follow("s1", true);
  expect(unfollowed).not.toHaveBeenCalled();
  expect(moves).toHaveLength(0);

  const v = { path: "", x: 0.5, y: 0.9 };
  layer.receive({
    session: "s1",
    name: "Asha",
    color: "#e11d48",
    points: [{ t: 1, path: "", x: 0, y: 0, hidden: true, v }],
  });
  vi.runOnlyPendingTimers();

  expect(moves).toEqual([expect.objectContaining({ x: 500, y: 3600 })]);
  const frame = document.querySelector(".slashdocs-follow");
  expect(frame).toHaveAttribute("data-on");
  // The app's doc bar names whom the view follows: the frame covers no text.
  expect(frame).toBeEmptyDOMElement();
  expect(unfollowed).not.toHaveBeenCalled();
});

test("a viewer sends their view at once, before any pointer move", () => {
  const report = vi.fn();
  trackPointer(document, report);
  vi.runOnlyPendingTimers();
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ hidden: true, v: expect.objectContaining({ path: "" }) }),
  );
});

// jsdom has no layout: a character is 10 px wide and 20 px high, and each
// text node of a paragraph is on a line of its own, 100 px under the last.
function layOutText() {
  const rects = function (this: Range) {
    const text = this.startContainer;
    if (text.nodeType !== Node.TEXT_NODE || this.collapsed) return [];
    const walker = document.createTreeWalker(
      text.parentElement!.closest("p")!,
      NodeFilter.SHOW_TEXT,
    );
    let line = 0;
    while (walker.nextNode() !== text) line++;
    const width = (this.endOffset - this.startOffset) * 10;
    return [new DOMRect(this.startOffset * 10, line * 100, width, 20)];
  };
  Object.assign(Range.prototype, { getClientRects: rects });
}

test("an editor sends the block of their caret and its offset in the text", () => {
  document.body.innerHTML =
    '<p>One</p><p>Hello <mark class="slashdocs-mark">big</mark>' +
    '<button class="slashdocs-heading-link">#</button> <b>wide</b> world</p>';
  // jsdom has no design mode.
  Object.assign(document, { designMode: "off" });
  document.body.setAttribute("contenteditable", "true");
  document.body.focus();
  const [block, bold] = [
    document.querySelectorAll("p")[1],
    document.querySelector("b")!,
  ];
  document.getSelection()!.collapse(bold.firstChild, 2);
  const report = vi.fn();
  trackPointer(document, report);
  document.dispatchEvent(new Event("selectionchange"));
  vi.advanceTimersToNextFrame();
  // The text of a highlight counts. The text of a control of the bridge does not.
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ e: "1", c: 12 }));
  expect(caretOffset(block, block, block.childNodes.length)).toBe(20);
  expect(caretOffset(block, block, 0)).toBe(0);
});

test("the caret of an editor shows at its offset in the text of the block", () => {
  layOutText();
  document.body.innerHTML = "<p>One</p><p>Hello <b>wide</b> world</p>";
  const block = document.querySelectorAll("p")[1];
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 60));
  const layer = createCursorLayer(() => document);
  const edit = (c?: number) => {
    layer.receive({
      session: "s1",
      name: "Asha",
      color: "#e11d48",
      points: [{ t: c ?? 0, path: "", x: 0, y: 0, hidden: true, e: "1", c }],
    });
    vi.advanceTimersToNextFrame();
    const [bar, caret] = Array.from(
      document.querySelectorAll<HTMLElement>(".slashdocs-edit > i"),
    );
    expect(bar.style.height).toBe("60px");
    return caret.style.cssText;
  };
  // At the start of the text, the character after the caret gives its place.
  expect(edit(0)).toBe("left: -1px; top: 0px; height: 20px;");
  // After "wi" in the second text: 20 px in, on the line of that text.
  expect(edit(8)).toBe("left: 19px; top: 100px; height: 20px;");
  // The other person typed more text than this document has yet.
  expect(caretLine(block, 99).x).toBe(60);
  // The text gets one more character: the caret keeps its offset in it.
  block.firstChild!.textContent = "Hello, ";
  layer.refresh();
  vi.advanceTimersToNextFrame();
  expect(
    document.querySelectorAll<HTMLElement>(".slashdocs-edit > i")[1].style.left,
  ).toBe("9px");
  // A point without a caret offset shows no caret.
  expect(edit()).toBe("display: none;");
  expect(document.querySelector(".slashdocs-edit > span")).toHaveTextContent(
    "Asha is editing",
  );
});
