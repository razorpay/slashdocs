import { assert, test } from "vitest";
import { parseSource } from "./source-map";

function textNode(doc: Document, text: string): Text {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node as Text;
  }
  throw new Error(`no text node with ${text}`);
}

function at(html: string, text: string, delta = 0): number {
  const source = parseSource(html)!;
  const node = textNode(source.doc, text);
  return source.position(node, node.data.indexOf(text) + delta, "start")!;
}

test("plain text offsets map one to one", () => {
  const html = "<!doctype html><p>Hello world</p>";
  assert.strictEqual(at(html, "world"), html.indexOf("world"));
});

test("character references count as one rendered character", () => {
  const html = "<p>Tom &amp; Jerry&nbsp;run &#x1F600; fast</p>";
  assert.strictEqual(at(html, "Jerry"), html.indexOf("Jerry"));
  assert.strictEqual(at(html, "run"), html.indexOf("run"));
  assert.strictEqual(at(html, "fast"), html.indexOf("fast"));
});

test("CRLF line endings count as one rendered character", () => {
  const html = "<p>one\r\ntwo</p>";
  assert.strictEqual(at(html, "two"), html.indexOf("two"));
});

test("a leading newline dropped inside pre is skipped", () => {
  const html = "<pre>\ncode here</pre>";
  assert.strictEqual(at(html, "here"), html.indexOf("here"));
});

test("element boundaries map to tag edges", () => {
  const html = "<p>Pay <strong>the bill</strong> today</p>";
  const source = parseSource(html)!;
  const p = source.doc.querySelector("p")!;
  assert.strictEqual(source.position(p, 1, "start"), html.indexOf("<strong>"));
  assert.strictEqual(
    source.position(p, 2, "end"),
    html.indexOf("</strong>") + "</strong>".length,
  );
});

test("an element with an omitted end tag has no end position", () => {
  const html = "<p>Pay <b>the bill<p>next</p>";
  const source = parseSource(html)!;
  const p = source.doc.querySelector("p")!;
  assert.isNull(source.position(p, 2, "end"));
});

test("templates are skipped and the rest still pairs", () => {
  const html = "<template><p>hidden</p></template><p>shown text</p>";
  assert.strictEqual(at(html, "shown"), html.indexOf("shown"));
});
