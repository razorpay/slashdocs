import { afterEach, assert, test } from "vitest";
import {
  CLUSTER_RADIUS,
  clusterPins,
  createPinLayer,
  parsePins,
  pinBlocks,
  pinElement,
  pointAt,
} from "../bridge/pins.ts";
import { elementAtPath, pathOf } from "../bridge/cursors.ts";
import { highlightRange, reveal } from "../bridge/highlight.ts";
import { cover } from "../bridge/dom.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

test("pins from the app are checked, and anything malformed is dropped", () => {
  const anchor = (point: Record<string, unknown>) => ({ quote: "Revenue", point });
  const pins = parsePins([
    {
      id: "c1",
      anchor: anchor({ target: "chart", x: 0.4, y: 0.2 }),
      initials: "IN",
      replies: 2,
    },
    { id: "c2", anchor: anchor({ path: "0.3", x: -0.5, y: 1.5 }) },
    { id: "d1", anchor: anchor({ x: 0, y: 1 }), draft: true },
    {
      id: "paged",
      anchor: anchor({ x: 0, y: 0, page_x: 120, page_y: 0, viewport_w: 1280 }),
    },
    // A page spot without its viewport is dropped, and the pin kept.
    { id: "half", anchor: anchor({ target: "t", x: 0, y: 0, page_x: 120, page_y: 9 }) },
    { id: "bad-x", anchor: anchor({ target: "t", x: 1001, y: 0 }) },
    { id: "bad-target", anchor: anchor({ target: "has space", x: 0, y: 0 }) },
    { id: "bad-path", anchor: anchor({ path: "0..1", x: 0, y: 0 }) },
    { id: "no-anchor" },
    null,
    "nope",
  ]);
  assert.deepEqual(
    pins.map((p) => p.id),
    ["c1", "c2", "d1", "paged", "half"],
  );
  assert.deepEqual(pins[3].anchor.point, {
    target: "",
    path: "",
    label: "",
    x: 0,
    y: 0,
    page_x: 120,
    page_y: 0,
    viewport_w: 1280,
  });
  assert.strictEqual(pins[4].anchor.point.page_x, undefined);
  assert.strictEqual(pins[0].replies, 2);
  assert.strictEqual(pins[0].anchor.quote, "Revenue");
  assert.strictEqual(pins[2].draft, true);
  assert.deepEqual(parsePins("not an array"), []);
});

test("pins close on screen cluster around the first pin, which keeps its place", () => {
  const pins = [
    { id: "a", x: 100, y: 100 },
    { id: "b", x: 110, y: 105 },
    { id: "c", x: 300, y: 300 },
    { id: "d", x: 100 + CLUSTER_RADIUS - 1, y: 100 },
  ];
  const clusters = clusterPins(pins, CLUSTER_RADIUS);
  assert.deepEqual(
    clusters.map((c) => c.members.map((m) => m.id)),
    [["a", "b", "d"], ["c"]],
  );
  assert.strictEqual(clusters[0].seed.id, "a");
});

test("500 random pins leave every member within the radius of its seed", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pins = Array.from({ length: 500 }, (_, i) => ({
    id: `p${i}`,
    x: random() * 2000,
    y: random() * 1200,
  }));
  const clusters = clusterPins(pins, CLUSTER_RADIUS);
  assert.strictEqual(
    clusters.reduce((n, c) => n + c.members.length, 0),
    500,
  );
  for (const c of clusters)
    for (const m of c.members)
      assert.ok(Math.hypot(m.x - c.seed.x, m.y - c.seed.y) <= CLUSTER_RADIUS);
});

// jsdom has no layout: give every element the same box, in a page of
// 1280 by 2000.
function layout() {
  document.elementFromPoint = (() =>
    document.querySelector("#card h3")) as typeof document.elementFromPoint;
  Element.prototype.getBoundingClientRect = function () {
    return new DOMRect(100, 200, 400, 100);
  };
  pageSize(1280, 2000);
}

// pageSize sets the size of the page, in a viewport of the window's size
// without scroll bars.
function pageSize(width: number, height: number) {
  for (const [key, value] of [
    ["scrollWidth", width],
    ["scrollHeight", height],
    ["clientWidth", window.innerWidth],
    ["clientHeight", window.innerHeight],
  ] as const)
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
}

// boxes gives each element with an id the box of that id, and every other
// element an empty box.
function boxes(byId: Record<string, DOMRect>) {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return byId[this.id] ?? new DOMRect();
  };
}

test("a spot names its element by id, path and the start of its text", () => {
  document.body.innerHTML =
    '<main><section id="card"><h3 aria-label="Plan">Plan for Q3</h3><p>Ship it.</p></section></main>';
  layout();
  const spot = pointAt(document, 200, 225);
  assert.deepEqual(spot?.point, {
    path: "0.0.0",
    label: "Plan",
    x: 0.25,
    y: 0.25,
    page_x: 200,
    page_y: 225,
    viewport_w: window.innerWidth,
  });
  assert.strictEqual(spot?.quote, "Plan for Q3");
});

test("a pin finds its element by target, else by path, else by its text", () => {
  document.body.innerHTML =
    '<main><div data-slashdocs-target="chart"></div><p>First</p><p id="second">Second para</p></main>';
  const at = (point: Record<string, unknown>, quote = "") =>
    pinElement(document, { quote, point: { x: 0, y: 0, ...point } });
  assert.strictEqual(at({ target: "chart" })?.localName, "div");
  assert.strictEqual(at({ target: "second" })?.id, "second");
  assert.strictEqual(at({ path: "0.1" }, "First")?.textContent, "First");
  // Content moved: the path now holds other text, so the quote finds it.
  document.querySelector("main")!.prepend(document.createElement("hr"));
  assert.strictEqual(at({ path: "0.1" }, "First")?.textContent, "First");
  assert.strictEqual(at({ target: "gone" }), null);
  assert.strictEqual(at({ path: "0.1" }, "Nowhere in it"), null);
});

test("a spot beside no block, as below a short body, stays where it is, on the body", () => {
  document.body.innerHTML =
    '<main id="page"><h1>Pricing</h1><p>Wide margins</p></main>';
  document.elementFromPoint = (() =>
    document.documentElement) as typeof document.elementFromPoint;
  // The html element fills the viewport, below the body too.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this === document.documentElement) return new DOMRect(0, 0, 1280, 800);
    return this === document.body
      ? new DOMRect(300, 0, 600, 400)
      : new DOMRect(300, 0, 600, 100);
  };
  const spot = pointAt(document, 120, 220)!;
  assert.deepEqual(spot.point, {
    path: "",
    label: "Pricing",
    x: -0.3,
    y: 0.55,
    page_x: 120,
    page_y: 220,
    viewport_w: window.innerWidth,
  });
  assert.strictEqual(spot.quote, "");
  assert.strictEqual(pinElement(document, spot), document.body);

  // Nothing takes a pin outside the viewport.
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  assert.strictEqual(pointAt(document, 50, -100), null);
});

test("a spot on a small element goes to its container, at the same spot", () => {
  document.body.innerHTML =
    '<section id="card"><i id="dot"></i><h2>Plan</h2><p>Ship it.</p></section>';
  document.elementFromPoint = (() =>
    document.getElementById("dot")) as typeof document.elementFromPoint;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.id === "dot") return new DOMRect(110, 210, 6, 6);
    return new DOMRect(100, 200, 400, 100);
  };
  const spot = pointAt(document, 112, 212)!;
  assert.deepEqual(spot.point, {
    target: "card",
    path: "0",
    label: "Plan",
    x: 0.03,
    y: 0.12,
    page_x: 112,
    page_y: 212,
    viewport_w: window.innerWidth,
  });
});

test("a pin on an element without text is not moved to another element", () => {
  document.body.innerHTML = '<main><img alt="Logo"><canvas></canvas><svg></svg></main>';
  layout();
  document.elementFromPoint = (() =>
    document.querySelector("canvas")) as typeof document.elementFromPoint;
  const spot = pointAt(document, 200, 250)!;
  assert.deepEqual(spot.point, {
    path: "0.1",
    label: "canvas",
    x: 0.25,
    y: 0.5,
    page_x: 200,
    page_y: 250,
    viewport_w: window.innerWidth,
  });
  assert.strictEqual(pinElement(document, spot)?.localName, "canvas");
  // The image before it is gone: the svg now holds the path.
  document.querySelector("img")!.remove();
  assert.strictEqual(pinElement(document, spot), null);
});

test("a highlight painted in an svg does not change the paths in it", () => {
  document.body.innerHTML =
    '<svg><text id="a">Revenue</text><circle></circle><text>Cost</text></svg>';
  const proto = SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
  proto.getBBox = () => new DOMRect(0, 0, 40, 10);
  try {
    const circle = document.querySelector("circle")!;
    const before = pathOf(circle);
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("a")!);
    assert.ok(highlightRange(range, false, "c1", false) > 0);
    assert.ok(
      document.querySelector(".slashdocs-svg-mark-rect"),
      "a highlight is painted",
    );
    assert.strictEqual(pathOf(circle), before);
    assert.strictEqual(elementAtPath(document, before), circle);
  } finally {
    delete proto.getBBox;
  }
});

test("the copy-link button at the start of a heading does not change its paths", () => {
  document.body.innerHTML =
    '<h2><button class="slashdocs-heading-link"></button>Plan <code>q3</code></h2>';
  const code = document.querySelector("code")!;
  assert.strictEqual(pathOf(code), "0.0");
  assert.strictEqual(elementAtPath(document, "0.0"), code);
});

test("a new pin shows and has its spot at once, before the next frame", () => {
  document.body.innerHTML = '<main><p id="spot">Pin here</p></main>';
  layout();
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  layer.setPins(
    parsePins([
      {
        id: "draft:1",
        anchor: { quote: "", point: { target: "spot", x: 0.5, y: 0.5 } },
        draft: true,
      },
    ]),
    "draft:1",
  );
  assert.deepEqual(layer.rect("draft:1"), {
    left: 300,
    top: 222,
    width: 28,
    height: 28,
  });
  assert.ok(document.querySelector('.sd-pin[data-id="draft:1"]'));
});

test("a pin whose element is gone shows at its page spot, marked as moved", () => {
  document.body.innerHTML = "<main><p>Rewritten</p></main>";
  layout();
  const posted: Record<string, unknown>[] = [];
  const layer = createPinLayer({
    doc: () => document,
    post: (message) => posted.push(message),
    laidOut: () => {},
  });
  layer.start(document);
  const gone = { target: "intro", x: 0.5, y: 0.5 };
  layer.setPins(
    parsePins([
      {
        id: "moved",
        anchor: {
          quote: "",
          point: {
            ...gone,
            page_x: 60,
            page_y: 300,
            viewport_w: window.innerWidth / 2,
          },
        },
      },
      { id: "lost", anchor: { quote: "", point: gone } },
    ]),
  );
  // Its x follows the viewport's width, which doubled.
  assert.deepEqual(layer.rect("moved"), { left: 120, top: 272, width: 28, height: 28 });
  assert.strictEqual(layer.rect("lost"), null);
  const pin = document.querySelector<HTMLElement>('.sd-pin[data-id="moved"]')!;
  assert.ok("moved" in pin.dataset);
  assert.strictEqual(pin.getAttribute("aria-label"), "Comment, moved");
  assert.deepEqual(
    posted.filter((m) => m.type === "slashdocs:pins-result").at(-1)?.results,
    [
      { id: "moved", placed: true, moved: true },
      { id: "lost", placed: false, moved: false },
    ],
  );
});

test("placing a pin shows a hint until it ends", () => {
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  layer.setPlacing(true);
  assert.strictEqual(
    document.querySelector(".sd-place-hint")?.textContent,
    "Click a spot, or use Tab and Enter. Esc to cancel.",
  );
  layer.setPlacing(false);
  assert.strictEqual(document.querySelector(".sd-place-hint"), null);
});

test("a cluster keeps the open pin and wears its first pin's color, and a pin that leaves it pops in", () => {
  document.body.innerHTML = '<main><p id="spot">Pin here</p></main>';
  layout();
  // Opening a pin brings it into view.
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
  Element.prototype.scrollIntoView = () => {};
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  const pin = (id: string, x: number, color = "#999") => ({
    id,
    color,
    anchor: { quote: "", point: { target: "spot", x, y: 0.5 } },
  });
  const far = pin("far", 0);
  layer.setPins(
    parsePins([pin("a", 0.5, "#111"), pin("b", 0.5), pin("c", 0.5), far]),
    "b",
  );
  const cluster = document.querySelector<HTMLElement>(".sd-cluster")!;
  assert.strictEqual(cluster.getAttribute("aria-label"), "3 comment threads");
  assert.ok("active" in cluster.dataset, "the cluster shows the open thread");
  assert.strictEqual(cluster.style.getPropertyValue("--c"), "#111");
  assert.deepEqual(
    Array.from(document.querySelectorAll<HTMLElement>(".sd-pin"), (b) => b.dataset.id),
    ["far"],
  );

  layer.setPins(parsePins([pin("a", 0.5), far]));
  const shown = (id: string) =>
    document.querySelector<HTMLElement>(`.sd-pin[data-id="${id}"]`)!.dataset;
  assert.ok("new" in shown("a"), "the pin that left the cluster pops in");
  assert.ok(!("new" in shown("far")), "the pin that stayed alone does not");
});

test("a spot in the page margin is on the block at its height, named as beside it", () => {
  document.body.innerHTML =
    '<main id="page"><h1 id="title">Pricing</h1><h2 id="steps">Steps</h2><p id="p">Do this.</p></main>';
  document.elementFromPoint = (() =>
    document.documentElement) as typeof document.elementFromPoint;
  boxes({
    page: new DOMRect(300, 0, 600, 400),
    title: new DOMRect(300, 0, 600, 100),
    steps: new DOMRect(300, 200, 600, 40),
    p: new DOMRect(300, 240, 600, 40),
  });
  Object.defineProperty(document.body, "getBoundingClientRect", {
    value: () => new DOMRect(300, 0, 600, 400),
    configurable: true,
  });
  try {
    const spot = pointAt(document, 120, 220)!;
    assert.deepEqual(spot.point, {
      target: "steps",
      path: "0.1",
      label: "Beside “Steps”",
      x: -0.3,
      y: 0.5,
      page_x: 120,
      page_y: 220,
      viewport_w: window.innerWidth,
    });
    assert.strictEqual(pinElement(document, spot)?.id, "steps");
    const layer = createPinLayer({
      doc: () => document,
      post: () => {},
      laidOut: () => {},
    });
    layer.start(document);
    layer.setPins(parsePins([{ id: "c1", anchor: spot }]));
    assert.strictEqual(
      document.querySelector('.sd-pin[data-id="c1"]')?.getAttribute("aria-label"),
      "Comment beside “Steps”",
    );
  } finally {
    delete (document.body as Partial<HTMLElement>).getBoundingClientRect;
  }
});

test("a pin whose spot is off the page shows at the edge of the page", () => {
  document.body.innerHTML = '<main><p id="steps">Steps</p></main>';
  layout();
  pageSize(390, 600);
  boxes({ steps: new DOMRect(10, 100, 370, 40) });
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  const gone = { target: "intro", x: 0, y: 0 };
  layer.setPins(
    parsePins([
      // Placed in a desktop margin, left of a wide block.
      {
        id: "margin",
        anchor: { quote: "", point: { target: "steps", x: -0.43, y: 0.5 } },
      },
      // Its element is gone, and the page got shorter than its spot.
      {
        id: "below",
        anchor: {
          quote: "",
          point: { ...gone, page_x: 100, page_y: 1367, viewport_w: window.innerWidth },
        },
      },
    ]),
  );
  assert.deepEqual(layer.rect("margin"), { left: 4, top: 92, width: 28, height: 28 });
  assert.deepEqual(layer.rect("below"), { left: 100, top: 572, width: 28, height: 28 });
  // The stored spots stay as they are.
  assert.strictEqual(layer.tops().find((t) => t.id === "below")?.top, 600);
});

test("a moved pin keeps its color and wears a dashed ring", () => {
  createPinLayer({ doc: () => document, post: () => {}, laidOut: () => {} });
  const css = Array.from(document.querySelectorAll("style"), (s) => s.textContent).join(
    "",
  );
  assert.match(css, /\.sd-pin\[data-moved\]\{outline:1\.5px dashed var\(--c/);
  assert.notMatch(css, /data-moved[^{]*\{[^}]*opacity/);
});

test("a pin turns its body away from the text beside its tip", () => {
  document.body.innerHTML = '<main><p id="badge">Pending</p></main>';
  layout();
  boxes({ badge: new DOMRect(200, 190, 80, 40) });
  // Text lies on the badge only.
  const word = document.querySelector("#badge")!.firstChild!;
  document.caretRangeFromPoint = (x: number, y: number) => {
    const range = document.createRange();
    range.setStart(x >= 200 && y >= 190 && y <= 230 ? word : document.body, 0);
    return range;
  };
  Range.prototype.getClientRects = function () {
    return [new DOMRect(200, 190, 80, 40)] as unknown as DOMRectList;
  };
  try {
    const layer = createPinLayer({
      doc: () => document,
      post: () => {},
      laidOut: () => {},
    });
    layer.start(document);
    layer.setPins(
      parsePins([
        {
          id: "c1",
          anchor: { quote: "", point: { target: "badge", x: 0.05, y: 0.5 } },
        },
      ]),
    );
    const pin = document.querySelector<HTMLElement>('.sd-pin[data-id="c1"]')!;
    assert.strictEqual(pin.dataset.turn, "left");
    // The tip stays at the spot, and the face is outside the badge.
    assert.deepEqual(layer.rect("c1"), { left: 176, top: 182, width: 28, height: 28 });
    assert.strictEqual(pin.style.transformOrigin, "28px 28px");
  } finally {
    delete (document as Partial<Document>).caretRangeFromPoint;
    delete (Range.prototype as Partial<Range>).getClientRects;
  }
});

test("the blocks that take a pin from the keyboard are the innermost text blocks and media", () => {
  document.body.innerHTML = `<section id="card"><h3 id="h">Plan</h3><p id="p">Ship <b>it</b>.</p></section>
    <ul id="list"><li id="li">One<ul><li id="inner">Two</li></ul></li></ul>
    <img id="img"><div id="empty"></div><button class="slashdocs-heading-link" id="ctl">#</button>`;
  Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  assert.deepEqual(
    pinBlocks(document).map((el) => el.id),
    ["h", "p", "li", "inner", "img"],
  );
});

test("Tab and the arrow keys ring the blocks while placing, Enter places, and Esc stops", () => {
  document.body.innerHTML = '<main><h2 id="a">Steps</h2><p id="b">Do this.</p></main>';
  layout();
  boxes({ a: new DOMRect(100, 100, 400, 30), b: new DOMRect(100, 140, 400, 60) });
  document.elementFromPoint = (() => document.body) as typeof document.elementFromPoint;
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
  const posted: Record<string, unknown>[] = [];
  const layer = createPinLayer({
    doc: () => document,
    post: (m) => posted.push(m),
    laidOut: () => {},
  });
  layer.start(document);
  const key = (key: string, shiftKey = false) => {
    const ev = new KeyboardEvent("keydown", {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const ring = () => document.querySelector<HTMLElement>(".sd-place-ring");

  assert.ok(!key("Tab"), "Tab is the page's own while not placing");
  layer.setPlacing(true);
  assert.ok(key("Tab"));
  assert.strictEqual(ring()?.style.translate, "100px 100px");
  key("ArrowDown");
  assert.strictEqual(ring()?.style.height, "60px");
  key("Tab", true);
  assert.strictEqual(ring()?.style.width, "400px");
  assert.strictEqual(ring()?.style.translate, "100px 100px");
  key("Enter");
  const placed = posted.find((m) => m.type === "slashdocs:pin-place");
  assert.deepEqual((placed?.anchor as { point: unknown }).point, {
    target: "a",
    path: "0.0",
    x: 0,
    y: 0,
    page_x: 100,
    page_y: 100,
    viewport_w: window.innerWidth,
  });
  assert.ok(!layer.isPlacing());
  assert.strictEqual(ring(), null);

  // Moving a pin places that pin, and Esc stops.
  layer.setPins(parsePins([{ id: "c1", anchor: placed!.anchor }]));
  layer.setPlacing(true, "c1");
  assert.strictEqual(
    document.querySelector(".sd-place-hint")?.textContent,
    "Click the new spot, or use Tab and Enter. Esc to cancel.",
  );
  key("ArrowDown");
  key("ArrowDown");
  key("Enter");
  const moved = posted.find((m) => m.type === "slashdocs:pin-move");
  assert.strictEqual(moved?.id, "c1");
  assert.strictEqual((moved?.anchor as { point: { path: string } }).point.path, "0.1");
  layer.setPlacing(true);
  key("Escape");
  assert.ok(!layer.isPlacing());
});

// textAt makes the document's text one word whose lines have the given
// boxes, found at every point.
function textAt(lines: DOMRect[]) {
  const word = document.body.appendChild(document.createTextNode("Repeat"));
  document.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(word, 0);
    return range;
  };
  Range.prototype.getClientRects = () => lines as unknown as DOMRectList;
  return () => {
    delete (document as Partial<Document>).caretRangeFromPoint;
    delete (Range.prototype as Partial<Range>).getClientRects;
  };
}

function pinOn(point: Record<string, unknown>) {
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  layer.setPins(parsePins([{ id: "c1", anchor: { quote: "", point } }]));
  return {
    layer,
    pin: () => document.querySelector<HTMLElement>('.sd-pin[data-id="c1"]'),
  };
}

test("a margin pin stays wholly in the page in view on each side, at 390 pixels", () => {
  document.body.innerHTML = '<main><p id="steps">Steps</p></main>';
  layout();
  // The page is 6px wider than the viewport, as Sol saw it.
  pageSize(372, 600);
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 366,
    configurable: true,
  });
  boxes({ steps: new DOMRect(16, 100, 334, 40) });
  for (const [x, left] of [
    // Placed in the right margin at 1440 pixels: the face turns left.
    [1.3, 334],
    // Placed in the left margin.
    [-0.43, 4],
  ]) {
    const { layer, pin } = pinOn({ target: "steps", x, y: 0.5 });
    assert.ok(pin(), `the pin at ${x} shows`);
    const rect = layer.rect("c1")!;
    assert.deepEqual(rect, { left, top: 92, width: 28, height: 28 });
    assert.ok(rect.left >= 0 && rect.left + rect.width <= 366);
    document.querySelector(".sd-pins")?.remove();
  }
});

test("a face that covers text on each turn goes to the nearest clear space, and points to its tip", () => {
  document.body.innerHTML = '<main><p id="p">Repeat repeat repeat.</p></main>';
  layout();
  boxes({ p: new DOMRect(100, 200, 400, 44) });
  const lines = [new DOMRect(100, 200, 400, 19), new DOMRect(100, 224, 400, 19)];
  const restore = textAt(lines);
  try {
    // In the middle of the second line.
    const { layer, pin } = pinOn({ target: "p", x: 0.5, y: 30 / 44 });
    const face = layer.rect("c1")!;
    // Just below the paragraph, under the tip, with its rim in the line's slack.
    assert.deepEqual(face, { left: 300, top: 239, width: 28, height: 28 });
    assert.strictEqual(pin()!.dataset.turn, "away");
    // The pointer runs from the middle of the face up to the tip at 300, 230.
    assert.strictEqual(
      pin()!.style.getPropertyValue("--len"),
      `${Math.hypot(14, 23)}px`,
    );
    assert.strictEqual(
      pin()!.style.getPropertyValue("--angle"),
      `${Math.atan2(-23, -14)}rad`,
    );
    assert.ok(pin()!.querySelector("s"), "the pin has a pointer");
  } finally {
    restore();
  }
});

test("a face with no clear space near turns to the side that covers the least", () => {
  document.body.innerHTML = '<main><p id="p">Repeat</p></main>';
  layout();
  boxes({ p: new DOMRect(0, 0, 1024, 768) });
  // Text on all the screen but a gap above the tip, too narrow for a face.
  const restore = textAt([
    new DOMRect(0, 210, 1024, 558),
    new DOMRect(0, 0, 284, 210),
    new DOMRect(300, 0, 724, 210),
  ]);
  try {
    const { layer, pin } = pinOn({ target: "p", x: 300 / 1024, y: 220 / 768 });
    assert.strictEqual(pin()!.dataset.turn, "left");
    assert.deepEqual(layer.rect("c1"), { left: 272, top: 192, width: 28, height: 28 });
  } finally {
    restore();
  }
});

test("an open moved pin shows one ring, the active one, dashed", () => {
  createPinLayer({ doc: () => document, post: () => {}, laidOut: () => {} });
  const css = Array.from(document.querySelectorAll("style"), (s) => s.textContent).join(
    "",
  );
  assert.match(
    css,
    /\.sd-pin\[data-moved\]\[data-active\]\{outline:2px dashed #2563eb;box-shadow:0 0 0 \.5px/,
  );
});

test("a pin and a cluster take a 40px hit area on a touch screen, with the same face", () => {
  createPinLayer({ doc: () => document, post: () => {}, laidOut: () => {} });
  const css = Array.from(document.querySelectorAll("style"), (s) => s.textContent).join(
    "",
  );
  assert.include(
    css,
    '@media (pointer:coarse),(max-width:639.98px){.sd-pin::before,.sd-cluster::before{content:"";position:absolute;inset:-6px;border-radius:50%}}',
  );
  assert.match(css, /\.sd-pin,\.sd-cluster\{[^}]*width:28px;height:28px/);
});

test("a pin or highlight opened under a comment sheet comes up above it", () => {
  document.body.innerHTML = '<main><p id="p">Paragraph 4</p></main>';
  layout();
  boxes({ p: new DOMRect(100, 600, 400, 40) });
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  try {
    const { layer } = pinOn({ target: "p", x: 0.5, y: 0.5 });
    // The pin shows: opened from the list, it stays.
    layer.setPins(
      parsePins([
        { id: "c1", anchor: { quote: "", point: { target: "p", x: 0.5, y: 0.5 } } },
      ]),
      "c1",
    );
    assert.deepEqual(scrolled, []);
    // A sheet covers the bottom 400px of the 768px view, and the pin with it.
    cover(document, 400);
    assert.match(
      document.getElementById("slashdocs-cover")!.textContent!,
      /scroll-padding-bottom:400px/,
    );
    assert.ok(layer.reveal("c1"));
    assert.deepEqual(scrolled, ["p"]);
    reveal(document.getElementById("p")!);
    assert.deepEqual(scrolled, ["p", "p"]);
    // The sheet closes.
    cover(document, 0);
    assert.strictEqual(document.getElementById("slashdocs-cover"), null);
    reveal(document.getElementById("p")!);
    assert.deepEqual(scrolled, ["p", "p"]);
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("a dragged pin shows once, under the pointer, while the app sends the pins again, and keeps its face where it is let go", () => {
  document.body.innerHTML = '<main><p id="spot">Drag me</p></main>';
  layout();
  const spot = document.querySelector("#spot")!;
  document.elementFromPoint = (() => spot) as typeof document.elementFromPoint;
  // Text above the tip turns the face down.
  const restore = textAt([new DOMRect(290, 215, 60, 30)]);
  const posted: Record<string, unknown>[] = [];
  const layer = createPinLayer({
    doc: () => document,
    post: (m) => posted.push(m),
    laidOut: () => {},
  });
  layer.start(document);
  const pins = [
    {
      id: "c1",
      anchor: { quote: "", point: { target: "spot", x: 0.5, y: 0.5 } },
      movable: true,
    },
  ];
  layer.setPins(parsePins(pins));
  const shown = () => document.querySelectorAll<HTMLElement>(".sd-pin");
  const at = () => [
    shown().length,
    shown()[0].style.translate,
    shown()[0].dataset.turn,
  ];
  const pointer = (type: string, clientX: number, clientY: number) =>
    shown()[0].dispatchEvent(
      new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true }),
    );
  try {
    // The tip is at 300, 250.
    assert.deepEqual(at(), [1, "300px 250px", "down"]);
    pointer("pointerdown", 310, 260);
    pointer("pointermove", 410, 310);
    assert.deepEqual(at(), [1, "400px 300px", "down"]);
    // The app sends the same pins again, as on any repaint of the page.
    layer.setPins(parsePins(pins));
    assert.deepEqual(at(), [1, "400px 300px", "down"]);
    // Where it is let go, no text is above the tip, but the face stays.
    pointer("pointerup", 410, 310);
    assert.strictEqual(posted.filter((m) => m.type === "slashdocs:pin-move").length, 1);
    assert.deepEqual(at(), [1, "400px 300px", "down"]);
  } finally {
    restore();
  }
});

test("an unread pin wears a dot, and bumps when a reply makes it unread", () => {
  document.body.innerHTML = '<main><p id="spot">Pin here</p></main>';
  layout();
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  const pins = (unread: boolean) =>
    parsePins([
      {
        id: "c1",
        anchor: { quote: "", point: { target: "spot", x: 0.5, y: 0.5 } },
        unread,
      },
    ]);
  const pin = () => document.querySelector<HTMLElement>('.sd-pin[data-id="c1"]')!;
  layer.setPins(pins(true));
  assert.ok(pin().hasAttribute("data-unread"));
  assert.notOk(
    pin().hasAttribute("data-bump"),
    "a pin that loads unread does not bump",
  );
  layer.setPins(pins(false));
  assert.notOk(pin().hasAttribute("data-unread"));
  layer.setPins(pins(true));
  assert.ok(pin().hasAttribute("data-unread"));
  assert.ok(pin().hasAttribute("data-bump"));
});

test("a pin that the reader went to sends out one ring", () => {
  document.body.innerHTML = '<main><p id="spot">Pin here</p></main>';
  layout();
  const animation = { onfinish: null as (() => void) | null };
  Element.prototype.animate = (() => animation) as unknown as Element["animate"];
  const layer = createPinLayer({
    doc: () => document,
    post: () => {},
    laidOut: () => {},
  });
  layer.start(document);
  layer.setPins(
    parsePins([
      { id: "c1", anchor: { quote: "", point: { target: "spot", x: 0.5, y: 0.5 } } },
    ]),
  );
  assert.notOk(layer.pulse("c2"), "a pin that does not show sends no ring");
  assert.ok(layer.pulse("c1"));
  assert.ok(document.querySelector('.sd-pin[data-id="c1"] > u'));
  animation.onfinish?.();
  assert.notOk(document.querySelector('.sd-pin[data-id="c1"] > u'));
});
