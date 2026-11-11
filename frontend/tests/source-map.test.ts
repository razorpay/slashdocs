import { assert, describe, test } from "vitest";

import { createSourceMap } from "../bridge/source-map.ts";
import { SOURCE_ATTR } from "../bridge/source-pieces.ts";
import {
  applyRegions,
  parseSource,
  replacementsBetween,
  tagSource,
} from "../src/lib/source-edits.ts";

// The bridge prelude that the server puts after the <head> start tag.
const PRELUDE = '<script id="slashdocs-bootstrap">window.slashdocs={}</script>';

// open renders source as the server does, loads it as the frame's live
// document, and starts a source map over it, as the editor does. script
// changes the live document first, as the document's own scripts do.
async function open(source: string, script?: (d: Document) => void) {
  const tree = await parseSource(source);
  const tagged = tagSource(tree).replace(/<head[^>]*>/i, (head) => head + PRELUDE);
  const d = new DOMParser().parseFromString(tagged, "text/html");
  script?.(d);
  const changes = {
    touched: new Set<Element>(),
    beside: new Set<Element>(),
    made: new WeakSet<Node>(),
    removed: new Set<number>(),
  };
  const map = createSourceMap(d, tagged, changes);
  const at = (selector: string, index = 0) => d.querySelectorAll(selector)[index];
  // type changes the text of a node in the block that holds it.
  const type = (block: Element, node: Node, text: string) => {
    (node as Text).data = text;
    changes.touched.add(block);
  };
  // make adds a node as the editor would.
  const make = (html: string) => {
    const box = d.createElement("div");
    box.innerHTML = html;
    const el = box.firstElementChild!;
    for (const node of [el, ...Array.from(el.querySelectorAll("*"))])
      changes.made.add(node);
    return el;
  };
  const save = () => {
    const result = applyRegions(tree, map.regions());
    if ("refused" in result) assert.fail(result.refused);
    return result.html;
  };
  return { d, map, changes, at, type, make, save, tree, tagged };
}

const page = (body: string, head = "<title>T</title>") =>
  `<!doctype html>\n<html><head>${head}</head>\n<body>\n${body}\n</body></html>\n`;

// replaceNth replaces the nth occurrence of find, from 0.
function replaceNth(source: string, find: string, replacement: string, nth: number) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = source.indexOf(find, at + 1);
  assert.ok(at >= 0, "the fixture must have the text");
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

describe("repeated content", () => {
  test("an edit of one of three equal labels changes only that one", async () => {
    const source = page(
      [1, 2, 3].map((n) => `<p><strong>Try it.</strong> Step ${n}</p>`).join("\n"),
    );
    const doc = await open(source);
    const strong = doc.at("strong", 1);
    doc.type(strong.parentElement!, strong.firstChild!, "Do it.");
    assert.equal(doc.save(), replaceNth(source, "Try it.", "Do it.", 1));
  });

  test("an edit of the third of equal list items changes only it", async () => {
    const source = page("<ul>\n<li>Same</li>\n<li>Same</li>\n<li>Same</li>\n</ul>");
    const doc = await open(source);
    const li = doc.at("li", 2);
    doc.type(li, li.firstChild!, "Other");
    assert.equal(doc.save(), replaceNth(source, "Same", "Other", 2));
  });

  test("an edit of the third of equal cells changes only it", async () => {
    // The rows have no <tbody> in the source, and the cells no end tags.
    const source = page("<table>\n<tr><td>0<td>0<td>0\n</table>");
    const doc = await open(source);
    const td = doc.at("td", 2);
    doc.type(td, td.firstChild!, "1\n");
    assert.equal(doc.save(), replaceNth(source, "0\n", "1\n", 0));
  });

  test("a heading equal to the title changes only the heading", async () => {
    const source = page("<h1>Plan</h1>\n<p>Body</p>", "<title>Plan</title>");
    const doc = await open(source);
    const h1 = doc.at("h1");
    doc.type(h1, h1.firstChild!, "New plan");
    assert.equal(doc.save(), source.replace("<h1>Plan</h1>", "<h1>New plan</h1>"));
  });
});

describe("character references", () => {
  test("unchanged text keeps its spelling in an edited text and outside it", async () => {
    const source = page(
      "<p>Tom &amp; Jerry&nbsp;&#160;&gt; old</p>\n<p>A&nbsp;&amp;&nbsp;B</p>",
    );
    const doc = await open(source);
    const p = doc.at("p");
    const text = p.firstChild as Text;
    doc.type(p, text, text.data.replace("old", "new"));
    assert.equal(doc.save(), source.replace("old", "new"));
  });

  test("typed text is escaped, and a typed non-breaking space is a space", async () => {
    const source = page("<p>a</p>");
    const doc = await open(source);
    const p = doc.at("p");
    doc.type(p, p.firstChild!, "a <b> & c\u00a0");
    assert.equal(doc.save(), source.replace("<p>a</p>", "<p>a &lt;b&gt; &amp; c </p>"));
  });
});

describe("script content", () => {
  test("a node that a script made, and a copy, are not editable and never saved", async () => {
    const source = page("<p>One</p>\n<p>Two</p>");
    const doc = await open(source, (d) => {
      const made = d.createElement("div");
      made.innerHTML = "<p>From a script</p>";
      d.body.insertBefore(made, d.querySelectorAll("p")[1]);
      d.body.append(d.querySelectorAll("p")[0].cloneNode(true));
    });
    const [one, made, , copy] = Array.from(doc.d.querySelectorAll("p"));
    assert.equal(made.closest("div")!.getAttribute("contenteditable"), "false");
    assert.equal(copy.getAttribute("contenteditable"), "false");
    assert.ok(doc.map.scriptOwned(made.firstChild!));
    assert.isNull(doc.map.offsetOf(copy));
    // The copy has the offset of the first paragraph: no live element owns it.
    assert.isNull(doc.map.offsetOf(one));
    const two = doc.at("p", 2);
    assert.isNotNull(doc.map.offsetOf(two));
    doc.type(two, two.firstChild!, "Second");
    assert.equal(doc.save(), source.replace("Two", "Second"));
  });

  test("an original element whose text a script set keeps its source", async () => {
    const source = page('<p>Now: <span id="clock">--</span> ok</p>');
    const doc = await open(source, (d) => {
      d.getElementById("clock")!.textContent = "12:00";
    });
    const clock = doc.d.getElementById("clock")!;
    assert.equal(clock.getAttribute("contenteditable"), "false");
    assert.ok(doc.map.scriptOwned(clock.firstChild!));
    const p = doc.at("p");
    doc.type(p, p.lastChild!, " fine");
    assert.equal(doc.save(), source.replace(" ok", " fine"));
  });

  test("a script that changes text later is marked on refresh", async () => {
    const source = page("<p>a</p>\n<p>b</p>");
    const doc = await open(source);
    const b = doc.at("p", 1);
    assert.isFalse(doc.map.scriptOwned(b.firstChild!));
    (b.firstChild as Text).data = "changed";
    doc.map.refresh([b.firstChild!]);
    assert.ok(doc.map.scriptOwned(b.firstChild!));
    doc.map.stop();
    assert.isFalse(b.hasAttribute("contenteditable"));
  });

  test("stop gives back the attribute that the element had", async () => {
    const source = page('<p contenteditable="true">a</p>');
    const doc = await open(source, (d) => {
      d.querySelector("p")!.textContent = "b";
    });
    const p = doc.at("p");
    assert.equal(p.getAttribute("contenteditable"), "false");
    doc.map.stop();
    assert.equal(p.getAttribute("contenteditable"), "true");
  });

  test("a region over an element that a script moved away is refused", async () => {
    const source = page("<div>\n<p>1</p>\n<p>2</p>\n<p>3</p>\n</div>");
    const doc = await open(source, (d) => {
      d.body.append(d.querySelectorAll("p")[1]);
    });
    const [one, three] = [doc.at("p"), doc.at("p", 1)];
    doc.type(one, one.firstChild!, "one");
    doc.type(three, three.firstChild!, "three");
    const result = applyRegions(doc.tree, doc.map.regions());
    assert.match("refused" in result ? result.refused : "", /leaves out <p> at/);
  });
});

describe("bridge nodes", () => {
  test("a comment highlight that splits edited text is left out", async () => {
    const source = page("<p>Hello&nbsp;big world</p>");
    const doc = await open(source);
    const p = doc.at("p");
    const text = p.firstChild as Text;
    const rest = text.splitText(6);
    rest.splitText(3);
    const mark = doc.d.createElement("mark");
    mark.className = "slashdocs-mark";
    p.replaceChild(mark, rest);
    mark.append(rest);
    doc.type(p, p.lastChild!, " wide world");
    assert.equal(doc.save(), source.replace("big world", "big wide world"));
  });

  test("a heading's link and id stay out of the source", async () => {
    const source = page("<h2>Title</h2>\n<p>x</p>");
    const doc = await open(source);
    const h2 = doc.at("h2");
    h2.id = "title";
    const link = doc.d.createElement("button");
    link.className = "slashdocs-heading-link";
    link.textContent = "#";
    h2.prepend(link);
    doc.type(h2, h2.lastChild!, "New title");
    assert.equal(doc.save(), source.replace("Title", "New title"));
  });
});

describe("structure", () => {
  test("only the replaced range changes", async () => {
    const source = page("<p>a</p>\n<p>b &amp; c</p>\n<p>d</p>");
    const doc = await open(source);
    const p = doc.at("p", 1);
    doc.type(p, p.firstChild!, "b & e");
    const saved = doc.save();
    const [{ start, end, new_html }] = replacementsBetween(source, saved);
    assert.equal(source.slice(0, start), saved.slice(0, start));
    assert.equal(source.slice(end), saved.slice(start + new_html.length));
    assert.equal(saved, source.replace("c</p>", "e</p>"));
  });

  test("Enter splits a paragraph into a new one with its attributes", async () => {
    const source = page('<p class="lead" id="intro">Hello world</p>\n<p>Next</p>');
    const doc = await open(source);
    const p = doc.at("p");
    assert.deepEqual(doc.map.attributesOf(p), [["class", "lead"]]);
    doc.type(p, p.firstChild!, "Hello");
    const next = doc.make('<p class="lead">world</p>');
    p.after(next);
    assert.equal(
      doc.save(),
      source.replace("Hello world</p>", 'Hello</p><p class="lead">world</p>'),
    );
  });

  test("Backspace joins a paragraph into the one before it", async () => {
    const source = page("<p>One</p>\n<p>Two <em>2</em></p>\n<p>Three</p>");
    const doc = await open(source);
    const [one, two] = [doc.at("p"), doc.at("p", 1)];
    one.append(...Array.from(two.childNodes));
    two.previousSibling!.remove();
    two.remove();
    doc.changes.touched.add(one);
    doc.changes.removed.add(Number(two.getAttribute(SOURCE_ATTR)));
    assert.equal(doc.save(), source.replace("One</p>\n<p>Two", "OneTwo"));
  });

  test("a new list item comes after the original ones", async () => {
    const source = page("<ul>\n<li>a</li>\n</ul>");
    const doc = await open(source);
    doc.at("ul").append(doc.make("<li>b <strong>c</strong></li>"));
    assert.equal(
      doc.save(),
      source.replace("</li>\n</ul>", "</li>\n<li>b <strong>c</strong></li>\n</ul>"),
    );
  });

  test("a new <br> that keeps an emptied block open is not saved", async () => {
    const source = page("<p>a</p>\n<p>b</p>");
    const doc = await open(source);
    const p = doc.at("p");
    p.firstChild!.remove();
    p.append(doc.make("<br>"));
    doc.changes.touched.add(p);
    assert.equal(doc.save(), source.replace("<p>a</p>", "<p></p>"));
  });

  test("new content keeps only allowed tags and attributes", async () => {
    const source = page("<p>a</p>");
    const doc = await open(source);
    const p = doc.at("p");
    p.append(
      doc.make(
        '<span style="x"><a href="javascript:x">b</a><a href="https://x.dev/?a&amp;b" onclick="x">c</a></span>',
      ),
    );
    doc.changes.touched.add(p);
    assert.equal(
      doc.save(),
      source.replace("<p>a</p>", '<p>ab<a href="https://x.dev/?a&amp;b">c</a></p>'),
    );
  });

  test("a deleted element inside an edited block goes with the region", async () => {
    const source = page("<p>a <em>b</em> c</p>");
    const doc = await open(source);
    const [p, em] = [doc.at("p"), doc.at("em")];
    em.remove();
    doc.changes.touched.add(p);
    doc.changes.removed.add(Number(em.getAttribute(SOURCE_ATTR)));
    assert.equal(doc.save(), source.replace(" <em>b</em>", " "));
  });

  test("a new list after a paragraph", async () => {
    const source = page("<p>a</p>\n<p>b</p>");
    const doc = await open(source);
    doc.at("p").after(doc.make("<ul><li>x</li><li>y</li></ul>"));
    assert.equal(
      doc.save(),
      source.replace("<p>a</p>", "<p>a</p><ul><li>x</li><li>y</li></ul>"),
    );
  });

  test("a later editing session keeps the editor's earlier changes editable", async () => {
    const source = page("<p>Hello world</p>");
    const doc = await open(source);
    const p = doc.at("p");
    doc.type(p, p.firstChild!, "Hello");
    const next = doc.make("<p>world</p>");
    p.after(next);
    doc.map.stop();
    const again = createSourceMap(doc.d, doc.tagged, doc.changes);
    assert.isFalse(p.hasAttribute("contenteditable"));
    assert.isFalse(next.hasAttribute("contenteditable"));
    const added = doc.d.createElement("aside");
    doc.d.body.append(added);
    again.refresh([added]);
    assert.ok(again.scriptOwned(added));
    const result = applyRegions(doc.tree, again.regions());
    assert.deepEqual(result, {
      html: source.replace("Hello world</p>", "Hello</p><p>world</p>"),
    });
  });
});

describe("sources", () => {
  test("multi-byte text before the region gives byte offsets", async () => {
    const source = page("<p>é😀</p>\n<p>x</p>");
    const doc = await open(source);
    const p = doc.at("p", 1);
    doc.type(p, p.firstChild!, "y");
    const saved = doc.save();
    const [replacement] = replacementsBetween(source, saved);
    const bytes = new TextEncoder().encode(source);
    const start = new TextEncoder().encode(
      source.slice(0, source.indexOf("x</p>")),
    ).length;
    assert.deepEqual(replacement, {
      start,
      end: start + 1,
      old_html: "x",
      new_html: "y",
    });
    assert.equal(new TextDecoder().decode(bytes.slice(start, start + 1)), "x");
  });

  test("a CRLF source keeps its line breaks", async () => {
    const source =
      "<!doctype html>\r\n<html><head><title>T</title></head>\r\n<body>\r\n" +
      "<p>one\r\ntwo</p>\r\n<p>three</p>\r\n</body></html>\r\n";
    const doc = await open(source);
    const p = doc.at("p");
    doc.type(p, p.firstChild!, "one\ntwo!");
    assert.equal(doc.save(), source.replace("two</p>", "two!</p>"));
  });

  test("a source with a byte order mark and no head", async () => {
    const source = "\ufeff<p>a</p>\n<p>b</p>";
    const doc = await open(source);
    const p = doc.at("p", 1);
    doc.type(p, p.firstChild!, "c");
    assert.equal(doc.save(), source.replace("b</p>", "c</p>"));
  });

  test("text in a body with no tags around it", async () => {
    const source = "<p>a</p>\ntext\n<p>b</p>";
    const doc = await open(source);
    const p = doc.at("p", 1);
    doc.type(p, p.firstChild!, "c");
    doc.at("p").after(doc.make("<p>new</p>"));
    assert.equal(doc.save(), "<p>a</p><p>new</p>\ntext\n<p>c</p>");
  });
});
