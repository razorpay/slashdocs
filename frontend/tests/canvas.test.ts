import { assert, test } from "vitest";
import {
  CLUSTER_RADIUS,
  clusterPins,
  parseCanvasMeta,
  parsePins,
} from "../bridge/canvas.ts";

test("the canvas tag needs a viewport and a world, and ignores other keys", () => {
  assert.deepEqual(parseCanvasMeta("viewport=#vp; world=#world"), {
    viewport: "#vp",
    world: "#world",
  });
  assert.deepEqual(parseCanvasMeta(" world = .w ;viewport=.v; v=1; later=yes "), {
    viewport: ".v",
    world: ".w",
  });
  for (const bad of [
    null,
    "",
    "viewport=#vp",
    "world=#w",
    `viewport=${"a".repeat(257)}; world=#w`,
  ])
    assert.strictEqual(parseCanvasMeta(bad), null, String(bad));
});

test("pins from the app are checked, and anything malformed is dropped", () => {
  const pins = parsePins([
    {
      id: "c1",
      point: { target: "t_mob", x: 0.4, y: 0.2 },
      initials: "IN",
      replies: 2,
    },
    { id: "c2", point: { target: "", x: 1, y: 0 }, resolved: true },
    { id: "d1", point: { target: "a.b:c-d", x: 0, y: 1 }, draft: true },
    { id: "bad-x", point: { target: "t", x: 1.5, y: 0 } },
    { id: "bad-target", point: { target: "has space", x: 0, y: 0 } },
    { id: "no-point" },
    null,
    "nope",
  ]);
  assert.deepEqual(
    pins.map((p) => p.id),
    ["c1", "c2", "d1"],
  );
  assert.strictEqual(pins[0].replies, 2);
  assert.strictEqual(pins[1].resolved, true);
  assert.strictEqual(pins[2].draft, true);
  assert.deepEqual(parsePins("not an array"), []);
});

test("pins close on screen cluster around the first, newest pin", () => {
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
  assert.strictEqual(clusters[0].seed.id, "a", "the seed keeps its own place");
});

test("the active pin and drafts are never clustered", () => {
  const pins = [
    { id: "a", x: 0, y: 0 },
    { id: "active", x: 1, y: 1 },
    { id: "b", x: 2, y: 2 },
  ];
  const clusters = clusterPins(pins, CLUSTER_RADIUS, new Set(["active"]));
  assert.deepEqual(
    clusters.map((c) => c.members.map((m) => m.id)),
    [["a", "b"], ["active"]],
  );
});

test("500 random pins at any zoom leave no two clusters overlapping", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const world = Array.from({ length: 500 }, (_, i) => ({
    id: `p${i}`,
    wx: random() * 20000,
    wy: random() * 12000,
  }));
  for (const s of [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 2, 3]) {
    const clusters = clusterPins(
      world.map((p) => ({ id: p.id, x: p.wx * s, y: p.wy * s })),
      CLUSTER_RADIUS,
    );
    assert.strictEqual(
      clusters.reduce((n, c) => n + c.members.length, 0),
      500,
      "every pin is shown",
    );
    for (const c of clusters)
      for (const m of c.members)
        assert.ok(
          Math.hypot(m.x - c.seed.x, m.y - c.seed.y) <= CLUSTER_RADIUS,
          "a member sits within the radius of its seed",
        );
  }
});
