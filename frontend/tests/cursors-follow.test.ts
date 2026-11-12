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

test("a caret after white space that does not show is at the text before it", () => {
  layOutText();
  // The browser collapses the second space of the first text and the line
  // breaks of the source: they have no box.
  const rects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function (this: Range) {
    const shown = /\S/.test(this.toString()) || this.startOffset === 5;
    return shown ? rects.call(this) : ([] as unknown as DOMRectList);
  };
  document.body.innerHTML = "<p>Hello  <b>wide</b>\n</p><p> \n</p>";
  const [block, blank] = Array.from(document.querySelectorAll("p"));
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 240));
  vi.spyOn(blank, "getBoundingClientRect").mockReturnValue(new DOMRect(5, 7, 300, 20));
  const line = ({ x, y, height }: DOMRect) => [x, y, height];
  // At the end of the block, after the line break: at the end of "wide".
  expect(line(caretLine(block, 12))).toEqual([40, 100, 20]);
  // After the two spaces: after the one that shows.
  expect(line(caretLine(block, 7))).toEqual([60, 0, 20]);
  // A block with no text that shows has the caret at its start.
  expect(line(caretLine(blank, 1))).toEqual([5, 7, 20]);
});

// The parts of the edit mark of the one other editor: the bar and the label
// of a block, and the caret, the flag and the wash of a place in its text.
function mark() {
  const el = document.querySelector<HTMLElement>(".slashdocs-edit")!;
  const part = (tag: string) => el.querySelector<HTMLElement>(`:scope > ${tag}`)!;
  return {
    el,
    bar: part("i"),
    label: part("span"),
    caret: part("u"),
    flag: part("em"),
    wash: Array.from(
      el.querySelectorAll<HTMLElement>(":scope > b"),
      (b) => b.style.cssText,
    ),
  };
}

// editor gives a layer, and a function that shows where Asha edits the
// second paragraph, at path: her caret at c, and the other end of her
// selection at a.
function editor(body = "<p>One</p><p>Hello <b>wide</b> world</p>", path = "1") {
  layOutText();
  document.body.innerHTML = body;
  const block = document.querySelectorAll("p")[1];
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 260));
  // A flag is 40 px wide and 14 px high.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(14);
  const layer = createCursorLayer(() => document);
  let t = 0;
  const edit = (c?: number, a?: number, own?: boolean) => {
    layer.receive({
      session: "s1",
      name: "Asha",
      color: "#e11d48",
      own,
      points: [{ t: ++t, path: "", x: 0, y: 0, hidden: true, e: path, c, a } as never],
    });
    vi.advanceTimersToNextFrame();
    return mark();
  };
  return { layer, block, edit };
}

afterEach(() => vi.restoreAllMocks());

test("the caret of an editor shows at its offset in the text of the block", () => {
  const { layer, block, edit } = editor();
  // At the start of the text, the character after the caret gives its
  // place. The view cuts the half of the caret that is left of its edge.
  expect(edit(0).caret.style.cssText).toBe(
    "left: 0px; top: 0px; width: 1px; height: 20px;",
  );
  // After "wi" in the second text: 20 px in, on the line of that text.
  expect(edit(8).caret.style.cssText).toBe(
    "left: 19px; top: 100px; width: 2px; height: 20px;",
  );
  // The other person typed more text than this document has yet.
  expect(caretLine(block, 99).x).toBe(60);
  // The text gets one more character: the caret keeps its offset in it.
  block.firstChild!.textContent = "Hello, ";
  layer.refresh();
  vi.advanceTimersToNextFrame();
  expect(mark().caret.style.left).toBe("9px");
});

test("the name of an editor is a flag on top of their caret, in their color", () => {
  const { edit } = editor();
  const { el, flag } = edit(8);
  expect(el.style.getPropertyValue("--c")).toBe("#e11d48");
  // The name only. The label of the block does not show with a caret.
  expect(flag).toHaveTextContent(/^Asha$/);
  expect(el).toHaveAttribute("data-caret");
  // The flag starts at the caret and ends at its top. Its corner at the
  // caret is square.
  expect(flag.style.cssText).toBe(
    "left: 19px; top: 86px; border-radius: 3px 3px 3px 0px;",
  );
  expect(edit(8, undefined, true).flag).toHaveTextContent(/^You$/);
});

test("the flag shows when the caret comes and when it moves, and goes two seconds later", () => {
  const { layer, edit } = editor();
  const { el, caret } = edit(8);
  expect(el).toHaveAttribute("data-flag");
  vi.advanceTimersByTime(1500);
  expect(el).toHaveAttribute("data-flag");
  vi.advanceTimersByTime(600);
  expect(el).not.toHaveAttribute("data-flag");
  // The same place again is not a move.
  expect(edit(8).el).not.toHaveAttribute("data-flag");
  expect(edit(9).el).toHaveAttribute("data-flag");
  // Each move starts the two seconds again.
  vi.advanceTimersByTime(1500);
  edit(10);
  vi.advanceTimersByTime(1500);
  expect(el).toHaveAttribute("data-flag");
  vi.advanceTimersByTime(600);
  expect(el).not.toHaveAttribute("data-flag");

  // A pointer at the caret shows the flag again. One that is far does not.
  layer.watchInput(document);
  vi.spyOn(caret, "getBoundingClientRect").mockReturnValue(new DOMRect(39, 100, 2, 20));
  const point = (clientX: number, clientY: number) =>
    document.body.dispatchEvent(
      new MouseEvent("pointermove", { clientX, clientY, bubbles: true }),
    );
  point(200, 110);
  expect(el).not.toHaveAttribute("data-flag");
  point(44, 124);
  expect(el).toHaveAttribute("data-flag");
  vi.advanceTimersByTime(2000);
  expect(el).not.toHaveAttribute("data-flag");
});

test("a jump to an editor puts their caret in the middle of the view", () => {
  const { layer, edit } = editor();
  const moves: { x: number; y: number }[] = [];
  const onFollow = (e: Event) => {
    e.preventDefault();
    moves.push((e as CustomEvent).detail);
  };
  window.addEventListener("slashdocs:follow", onFollow);
  // Asha has no pointer in the document and sent no view. Her caret is
  // after "wi", 20 px in, on a line from 100 px to 120 px.
  const { el } = edit(8);
  vi.advanceTimersByTime(3000);
  layer.follow("s1", false);
  window.removeEventListener("slashdocs:follow", onFollow);
  expect(moves).toHaveLength(1);
  expect(moves[0].x).toBeCloseTo(20, 0);
  expect(moves[0].y).toBeCloseTo(110, 0);
  // The flag says whose caret this is.
  expect(el).toHaveAttribute("data-flag");
});

test("a point with no caret offset keeps the bar and the label of the block", () => {
  const { edit } = editor();
  edit(8);
  const { el, bar, label } = edit();
  expect(el).not.toHaveAttribute("data-caret");
  expect(label).toHaveTextContent("Asha is editing");
  expect(bar.style.cssText).toBe("left: -6px; top: 0px; width: 2px; height: 260px;");
  expect(edit(undefined, undefined, true).label).toHaveTextContent(
    "You are editing in another tab",
  );
});

test("the flag goes under the caret when it has no room on top, or covers the selection toolbar", () => {
  const { edit } = editor();
  // The first line is at the top of the view.
  expect(edit(2).flag.style.cssText).toBe(
    "left: 19px; top: 20px; border-radius: 0px 3px 3px 3px;",
  );
  const toolbar = document.createElement("div");
  toolbar.className = "slashdocs-selection-action";
  document.body.append(toolbar);
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 60, 200, 40),
  );
  expect(edit(8).flag.style.top).toBe("120px");
  // A toolbar at another place does not move the flag.
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 60, 200, 40),
  );
  expect(edit(8).flag.style.top).toBe("86px");
});

test("the flag goes to the left of the caret at the right edge of the view", () => {
  const { edit } = editor(`<p>One</p><p>Hello <b>${"wide".repeat(30)}</b></p>`);
  // The caret is 1000 px in, and the view is 1024 px wide.
  expect(edit(106).flag.style.cssText).toBe(
    "left: 961px; top: 86px; border-radius: 3px 3px 0px 3px;",
  );
});

test("the selection of an editor is a wash on each of its lines, from either end", () => {
  const { edit } = editor();
  // From "llo " in the first text to "wi" in the second: one box for each.
  const lines = [
    "left: 20px; top: 0px; width: 40px; height: 20px;",
    "left: 0px; top: 100px; width: 20px; height: 20px;",
  ];
  expect(edit(8, 2).wash).toEqual(lines);
  expect(edit(2, 8).wash).toEqual(lines);
  // The caret is at the end that the person moves.
  expect(mark().caret.style.left).toBe("19px");
  // A selection of less text takes the other boxes out, and a caret has none.
  expect(edit(8, 6).wash).toEqual([lines[1]]);
  expect(edit(8).wash).toEqual([]);
});

test("a caret and a selection that scrolled out of their box do not show", () => {
  const { edit, block } = editor(
    '<p>One</p><div style="overflow-y:auto"><p>Hello <b>wide</b> world</p></div>',
    "1.0",
  );
  const scroller = block.parentElement!;
  Object.defineProperties(scroller, {
    scrollHeight: { value: 500 },
    clientHeight: { value: 110 },
  });
  // The box shows the first line, and the top half of the second.
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 110),
  );
  const { caret, flag, wash } = edit(8, 2);
  expect(caret.style.cssText).toBe("left: 19px; top: 100px; width: 2px; height: 10px;");
  expect(flag.hidden).toBe(false);
  expect(wash[1]).toBe("left: 0px; top: 100px; width: 20px; height: 10px;");
  // The caret is in the third text, under the box.
  const under = edit(12, 2);
  expect([under.caret.hidden, under.flag.hidden]).toEqual([true, true]);
  expect(under.wash).toHaveLength(2);
});

test("an editor sends the other end of a selection in the block of their caret", () => {
  document.body.innerHTML = "<p>One</p><p>Hello <b>wide</b> world</p>";
  Object.assign(document, { designMode: "off" });
  document.body.setAttribute("contenteditable", "true");
  document.body.focus();
  const [one, block] = Array.from(document.querySelectorAll("p"));
  const bold = block.querySelector("b")!.firstChild!;
  const report = vi.fn();
  trackPointer(document, report);
  const select = (...ends: [Node, number, Node, number]) => {
    document.getSelection()!.setBaseAndExtent(...ends);
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersToNextFrame();
    const { e, c, a } = report.mock.lastCall![0];
    return { e, c, a };
  };
  expect(select(block.firstChild!, 2, bold, 2)).toEqual({ e: "1", c: 8, a: 2 });
  // The person selected backward: the caret is at the start.
  expect(select(bold, 2, block.firstChild!, 2)).toEqual({ e: "1", c: 2, a: 8 });
  // A caret has no other end, and a selection from another block gives none.
  expect(select(bold, 2, bold, 2)).toEqual({ e: "1", c: 8, a: undefined });
  expect(select(one.firstChild!, 1, bold, 2)).toEqual({ e: "1", c: 8, a: undefined });
});
