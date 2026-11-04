import { afterEach, assert, test } from "vitest";
import {
  CLUSTER_RADIUS,
  clusterPins,
  parsePins,
  pinElement,
  pointAt,
} from "../bridge/pins.ts";

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
    { id: "c2", anchor: anchor({ path: "0.3", x: 1, y: 0 }) },
    { id: "d1", anchor: anchor({ x: 0, y: 1 }), draft: true },
    { id: "bad-x", anchor: anchor({ target: "t", x: 1.5, y: 0 }) },
    { id: "bad-target", anchor: anchor({ target: "has space", x: 0, y: 0 }) },
    { id: "bad-path", anchor: anchor({ path: "0..1", x: 0, y: 0 }) },
    { id: "no-anchor" },
    null,
    "nope",
  ]);
  assert.deepEqual(
    pins.map((p) => p.id),
    ["c1", "c2", "d1"],
  );
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
  assert.deepEqual(spot?.point, { path: "0.0.0", label: "Plan", x: 0.25, y: 0.25 });
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
