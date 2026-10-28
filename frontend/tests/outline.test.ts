import { assert, test } from "vitest";
import { activeHeading, collectOutline, sameOutline } from "../bridge/outline.ts";

function documentOf(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

test("the outline lists headings with ids in order, without bridge controls", () => {
  const d = documentOf(`
    <h1 id="intro">Intro <button class="slashdocs-heading-link">#</button></h1>
    <h2 id="setup">  Set   up </h2>
    <h3>No id</h3>
    <div hidden><h2 id="hidden">Hidden</h2></div>
    <h2 id="empty"> </h2>
    <h4 id="deep">Deep</h4>`);
  assert.deepEqual(collectOutline(d), [
    { id: "intro", level: 1, text: "Intro" },
    { id: "setup", level: 2, text: "Set up" },
    { id: "deep", level: 4, text: "Deep" },
  ]);
});

test("the active heading falls back to the first heading", () => {
  const d = documentOf(`<h1 id="a">A</h1><h2 id="b">B</h2>`);
  // jsdom lays nothing out, so no heading has client rects.
  assert.strictEqual(activeHeading(d, collectOutline(d)), "a");
  assert.strictEqual(activeHeading(d, []), "");
});

test("outlines compare by id, level and text", () => {
  const a = [{ id: "a", level: 1, text: "A" }];
  assert.isTrue(sameOutline(a, [{ id: "a", level: 1, text: "A" }]));
  assert.isFalse(sameOutline(a, [{ id: "a", level: 2, text: "A" }]));
  assert.isFalse(sameOutline(a, []));
});
