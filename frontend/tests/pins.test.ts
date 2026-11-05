import { afterEach, assert, test } from "vitest";
import {
  CLUSTER_RADIUS,
  clusterPins,
  createPinLayer,
  parsePins,
  pinElement,
  pointAt,
} from "../bridge/pins.ts";
import { elementAtPath, pathOf } from "../bridge/cursors.ts";
import { highlightRange } from "../bridge/highlight.ts";

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

// jsdom has no layout: give every element the same box.
function layout() {
  document.elementFromPoint = (() =>
    document.querySelector("#card h3")) as typeof document.elementFromPoint;
  Element.prototype.getBoundingClientRect = function () {
    return new DOMRect(100, 200, 400, 100);
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

test("a spot in the page margin stays where it is, on the body", () => {
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
    "Click to place a comment. Esc to cancel.",
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
