// @vitest-environment jsdom
import { afterEach, assert, beforeEach, describe, test, vi } from "vitest";
import { changedRects, QUIET_SHARE, watchView } from "../bridge/view.ts";

// jsdom has no layout, so the tests give one: each block is one line of 20
// px at a place in the page, and the view is 200 px high.
const LINE = 20;
const places = new Map<Element, number>();
const heights = new Map<Element, number>();
// The blocks whose box the view read.
const read = new Set<Element>();
let scroll = 0;

const box = (top: number, height = LINE) => new DOMRect(0, top, 300, height);

// lay puts the paragraphs of the body one line apart, from the first line.
function lay() {
  places.clear();
  heights.clear();
  Array.from(document.body.children).forEach((el, i) => places.set(el, i * LINE));
}

// A collapsed range where content of el went.
const went = (el: Element) =>
  ({
    startContainer: el,
    collapsed: true,
    intersectsNode: (node: Node) => node === el,
    getClientRects: () => [],
  }) as unknown as Range;

// A range of new content: the element that holds it, and its lines.
const change = (el: Element, lines = 1) =>
  ({
    startContainer: el,
    collapsed: false,
    intersectsNode: (node: Node) => node === el,
    getClientRects: () =>
      Array.from({ length: lines }, (_, i) => box(places.get(el)! + i * LINE - scroll)),
  }) as unknown as Range;

beforeEach(() => {
  scroll = 0;
  document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>${i}</p>`).join(
    "",
  );
  lay();
  read.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    read.add(this);
    return box((places.get(this) ?? 0) - scroll, heights.get(this) ?? LINE);
  });
  vi.stubGlobal("innerHeight", 200);
  // The page scrolls, unless a test gives an element that scrolls.
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(() => scroll);
  Element.prototype.scrollBy = ((to: ScrollToOptions) =>
    void (scroll += to.top ?? 0)) as never;
  Element.prototype.scrollTo = ((to: ScrollToOptions) =>
    void (scroll = to.top ?? 0)) as never;
});
afterEach(() => vi.restoreAllMocks());

const paragraph = (i: number) =>
  (document.querySelector("main") ?? document.body).children[i];
// add puts a new element of some lines before paragraph i, and the
// paragraphs after it move down.
function add(i: number, lines = 1, tag = "p") {
  const el = document.createElement(tag);
  const at = places.get(paragraph(i))!;
  for (const [other, top] of places)
    if (top >= at) places.set(other, top + lines * LINE);
  paragraph(i).before(el);
  places.set(el, at);
  heights.set(el, lines * LINE);
  return el;
}
// resize makes paragraph i some lines high, and the paragraphs after it move.
function resize(el: Element, lines: number) {
  const at = places.get(el)!;
  const by = lines * LINE - (heights.get(el) ?? LINE);
  for (const [other, top] of places)
    if (other !== el && top >= at) places.set(other, top + by);
  heights.set(el, lines * LINE);
}

// A paragraph of the view that the reader reads, as one line.
const READ = "The team meets on Monday at nine in the large room.";
const reads = (i: number) => Object.assign(paragraph(i), { textContent: READ });

describe("the view of a reader", () => {
  test("does not change for a change below it, also a large one", () => {
    const view = watchView(document);
    assert.equal(view.settle([change(add(30, 8), 8)]), 0);
    assert.equal(scroll, 0);
  });

  test("measures the blocks that hold no other block, and not the element around them", () => {
    document.body.innerHTML = `<div>${document.body.innerHTML}</div><div>Text</div>`;
    const [around, text] = Array.from(document.body.children);
    const inner = Array.from(around.children);
    inner.forEach((el, i) => places.set(el, i * LINE));
    places.set(around, 0);
    heights.set(around, inner.length * LINE);
    places.set(text, inner.length * LINE);

    watchView(document);

    assert.isFalse(read.has(around));
    assert.isTrue(read.has(inner[0]));
  });

  test("stays on its text when a change above it moves the page", () => {
    scroll = 300;
    const view = watchView(document);
    const el = add(2, 3);
    assert.equal(view.settle([change(el, 3)]), 0);
    // The scroll moved with the text that the reader reads.
    assert.equal(scroll, 360);
  });

  test("changes a little for one line of new words in it", () => {
    const view = watchView(document);
    const share = view.settle([change(paragraph(3))]);
    assert.equal(share, LINE / 200);
    assert.isBelow(share, QUIET_SHARE);
    assert.equal(scroll, 0);
  });

  test("stays quiet when a paragraph in it gets one more line", () => {
    const view = watchView(document);
    // The paragraphs below move by one line: a tenth of the view.
    const share = view.settle([change(add(3))]);
    assert.equal(share, LINE / 200);
    assert.isBelow(share, QUIET_SHARE);
  });

  test("changes much when a new paragraph of some lines in it moves the text below", () => {
    const view = watchView(document);
    const share = view.settle([change(add(3, 2), 2)]);
    // The two new lines, and the seven lines that they moved in the view.
    assert.equal(share, (9 * LINE) / 200);
    assert.isAtLeast(share, QUIET_SHARE);
  });

  test("keeps the text in its place, not a header that stays in the view", () => {
    scroll = 300;
    // The first paragraph of the view is in a sticky header.
    const header = document.createElement("header");
    header.style.position = "sticky";
    paragraph(15).before(header);
    header.append(paragraph(16));
    places.set(header.firstElementChild!, 300);
    const stuck = vi.mocked(Element.prototype.getBoundingClientRect);
    const laid = stuck.getMockImplementation()!;
    stuck.mockImplementation(function (this: Element) {
      return header.contains(this) ? box(0) : laid.call(this);
    });
    const view = watchView(document);
    assert.equal(view.settle([change(add(2, 3), 3)]), 0);
    assert.equal(scroll, 360);
  });

  test("changes much when many of its lines are new, also in the same places", () => {
    const view = watchView(document);
    const share = view.settle([2, 3, 4, 5].map((i) => change(paragraph(i))));
    assert.isAtLeast(share, QUIET_SHARE);
  });

  test("is not quiet when a block of it is rewritten, also one of one line", () => {
    const el = reads(3);
    const view = watchView(document);
    el.textContent = "Nobody knows yet when and where the next meeting is.";
    assert.equal(view.settle([change(el)]), 1);
  });

  test("is not quiet when most of a block of it goes, or all of the block", () => {
    const [cut, gone, other] = [reads(3), reads(30), reads(5)];
    let view = watchView(document);
    cut.textContent = "The team meets.";
    assert.equal(view.settle([]), 1);
    // The paragraph below the view goes: the reader does not read it.
    view = watchView(document);
    gone.remove();
    assert.equal(view.settle([]), 0);
    view = watchView(document);
    other.remove();
    assert.equal(view.settle([]), 1);
  });

  test("stays quiet when some words of a block change, and for a label", () => {
    const [el, label] = [reads(3), paragraph(4)];
    const view = watchView(document);
    el.textContent = READ.replace("Monday at nine", "Tuesday at ten");
    label.textContent = "41";
    const share = view.settle([change(el)]);
    assert.equal(share, LINE / 200);
    assert.isBelow(share, QUIET_SHARE);
  });

  test("stays quiet when a block gets a capital letter and a full stop", () => {
    const el = reads(3);
    el.textContent = READ.toLowerCase().slice(0, -1);
    const view = watchView(document);
    el.textContent = READ;
    assert.equal(view.settle([change(el)]), LINE / 200);
  });

  test("is not quiet when half of the words of a block are other words, in any order", () => {
    const el = reads(3);
    let view = watchView(document);
    // Six of the eleven words stay, and then five.
    el.textContent = "The team eats on Friday at noon in a small room.";
    assert.isBelow(view.settle([change(el)]), 1);
    reads(3);
    view = watchView(document);
    el.textContent = "The group eats on Friday at noon in a small room.";
    assert.equal(view.settle([change(el)]), 1);
    // A word counts as often as it is there.
    el.textContent = "no no no no yes yes yes";
    view = watchView(document);
    el.textContent = "no yes yes yes yes yes yes";
    assert.isBelow(view.settle([change(el)]), 1);
    view = watchView(document);
    el.textContent = "no no no no no yes yes";
    assert.equal(view.settle([change(el)]), 1);
  });

  test("counts the blocks that lose all their text, with no new text", () => {
    const view = watchView(document);
    for (const i of [1, 2, 3]) paragraph(i).textContent = "";
    paragraph(30).textContent = "";
    // Three lines of the view, and no line below it.
    const share = view.settle([]);
    assert.equal(share, (3 * LINE) / 200);
    assert.isAtLeast(share, QUIET_SHARE);
  });

  test("counts an image of the view that changes, with all of its height", () => {
    const img = Object.assign(document.createElement("img"), { src: "a.png" });
    paragraph(2).replaceWith(img);
    lay();
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (
      this: Element,
    ) {
      // The image is five lines high, over the paragraphs after it.
      return box((places.get(this) ?? 0) - scroll, this === img ? 5 * LINE : LINE);
    });
    let view = watchView(document);
    assert.equal(view.settle([]), 0);
    view = watchView(document);
    img.setAttribute("src", "b.png");
    assert.equal(view.settle([]), (5 * LINE) / 200);
  });

  test("measures a div that holds text, and not one that holds none", () => {
    const [text, empty] = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    text.textContent = READ;
    paragraph(3).replaceWith(text);
    paragraph(4).replaceWith(empty);
    lay();
    let view = watchView(document);
    places.set(empty, 500);
    assert.equal(view.settle([]), 0);
    view = watchView(document);
    text.textContent = "Nobody knows yet when and where the next meeting is.";
    assert.equal(view.settle([change(text)]), 1);
  });

  test("keeps the next block in its place when the first block lost text above the view", () => {
    scroll = 300;
    // The first block of the view is four lines from 240, and the last of
    // them is in the view.
    resize(paragraph(12), 4);
    const view = watchView(document);
    // Its first two lines go, above the view.
    resize(paragraph(12), 2);
    assert.equal(view.settle([went(paragraph(12))]), 0);
    assert.equal(scroll, 260);
  });

  test("is not quiet when a deletion takes lines out of a block in it", () => {
    // The last block of the view is four lines from 140: three are in it.
    resize(paragraph(7), 4);
    const view = watchView(document);
    // Three lines go. The text after it is below the view.
    resize(paragraph(7), 1);
    const share = view.settle([went(paragraph(7))]);
    assert.equal(share, (2 * LINE) / 200);
    assert.isAtLeast(share, QUIET_SHARE);
  });

  test("reads the blocks of the view, and not all the blocks above and below it", () => {
    scroll = 300;
    watchView(document);
    assert.isTrue(read.has(paragraph(15)));
    assert.isTrue(read.has(paragraph(24)));
    for (const i of [0, 1, 2, 3, 30, 39]) assert.isFalse(read.has(paragraph(i)));
  });

  test("scrolls the element that scrolls its text, in a page that does not scroll", () => {
    const main = document.createElement("main");
    main.style.overflowY = "auto";
    main.append(...Array.from(document.body.children));
    document.body.append(main);
    Object.defineProperties(main, {
      scrollHeight: { value: 800 },
      clientHeight: { value: 200 },
    });
    const page = vi.fn();
    Element.prototype.scrollBy = page;
    main.scrollBy = ((to: ScrollToOptions) => void (scroll += to.top ?? 0)) as never;
    scroll = 300;
    const view = watchView(document);
    assert.equal(view.settle([change(add(2, 3), 3)]), 0);
    assert.equal(scroll, 360);
    assert.equal(page.mock.calls.length, 0);
  });

  test("keeps its text in place when a new image above it loads, once", () => {
    scroll = 300;
    const view = watchView(document);
    const img = add(2, 0, "img");
    Object.defineProperty(img, "complete", { value: false });
    assert.equal(view.settle([went(img)]), 0);
    assert.equal(scroll, 300);
    // The image loads five lines high, and the text after it moves down.
    resize(img, 5);
    img.dispatchEvent(new Event("load"));
    assert.equal(scroll, 400);
    img.dispatchEvent(new Event("load"));
    assert.equal(scroll, 400);
  });

  test("goes back to its scroll when the change is taken out", () => {
    scroll = 300;
    const view = watchView(document);
    view.settle([change(add(2, 3), 3)]);
    view.restore();
    assert.equal(scroll, 300);
  });
});

describe("the flash of new content", () => {
  // jsdom has no layout: say that a paragraph is a block, and give each
  // range one rectangle that is as wide as its text is long.
  beforeEach(() => {
    Range.prototype.getClientRects = function (this: Range) {
      const { startOffset: from, endOffset: to } = this;
      return [new DOMRect(from, 0, to - from, LINE)] as never;
    };
  });
  afterEach(() => {
    delete (Range.prototype as Partial<Range>).getClientRects;
  });
  const ranges = (el: Element, ...words: [number, number][]) =>
    words.map(([from, to]) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, from);
      range.setEnd(el.firstChild!, to);
      return range;
    });
  const widths = (rects: DOMRect[]) => rects.map((rect) => rect.width);

  test("is on each range when they are at most half of the text of a block", () => {
    const el = reads(3);
    assert.deepEqual(widths(changedRects(ranges(el, [0, 3], [9, 14]))), [3, 5]);
  });

  test("is a thin line where text went", () => {
    const el = reads(3);
    const [range] = ranges(el, [4, 4]);
    assert.deepEqual(
      changedRects([range]).map(({ x, width }) => [x, width]),
      [[3, 2]],
    );
  });

  test("is on the block as one when the ranges are more than half of its text", () => {
    const [el, other] = [reads(3), reads(5)];
    const rects = changedRects([
      ...ranges(el, [0, 14], [20, 40]),
      ...ranges(other, [0, 3]),
    ]);
    // All of the first paragraph, and the one range of the other.
    assert.deepEqual(widths(rects), [300, 3]);
  });
  test("is on the whole word when a patch changed parts of it", () => {
    const el = reads(3);
    // "meets" is 9 to 14: its "m", "eet" and "s" changed.
    const rects = changedRects(ranges(el, [9, 10], [11, 13], [13, 14], [12, 12]));
    assert.deepEqual(
      rects.map(({ x, width }) => [x, width]),
      [[9, 5]],
    );
  });

  test("does not count a word with a new mark after it as another word", () => {
    const item = paragraph(3);
    item.textContent = "Write the notes for the team.";
    const view = watchView(document);
    item.textContent = "Write the notes for the team, again.";
    assert.isBelow(view.settle([change(item)]), QUIET_SHARE);
  });
});
