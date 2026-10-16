import { assert, test } from "vitest";

import { describeAnchor, resolveAnchor } from "../bridge/anchoring/index.ts";

// Regression tests for razorpay/slashdocs#187: a comment on one copy of a
// repeated phrase must not jump to another copy when its own copy is edited.

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

// Anchors a comment on the `occurrence`-th copy of `quote` in `html`.
function anchorOn(html: string, quote: string, occurrence: number) {
  const root = render(html);
  const text = root.textContent ?? "";
  let start = -1;
  for (let i = 0; i <= occurrence; i++) {
    start = text.indexOf(quote, start + 1);
  }
  assert.ok(start >= 0, "fixture must contain the quote");

  const range = document.createRange();
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (start >= offset && start + quote.length <= offset + len) {
      range.setStart(node, start - offset);
      range.setEnd(node, start - offset + quote.length);
      break;
    }
    offset += len;
  }
  const anchor = describeAnchor(root, range);
  assert.ok(anchor);
  return anchor;
}

// Describes where a resolved range landed: the paragraph's text, or null.
function landedIn(range: Range | null): string | null {
  if (!range) return null;
  return range.startContainer.parentElement?.textContent ?? null;
}

const plans = "<p>Plan A: TBD</p><p>Plan B: TBD</p><p>Plan C: done</p>";

test("a comment on an edited copy of repeated text is detached, not moved", () => {
  const anchor = anchorOn(plans, "TBD", 1); // the "TBD" after "Plan B:"

  const v2 = render(
    "<p>Plan A: TBD</p><p>Plan B: shipped 12 Oct</p><p>Plan C: done</p>",
  );
  assert.strictEqual(
    landedIn(resolveAnchor(v2, anchor)),
    null,
    "the comment should be detached, not moved to Plan A",
  );
});

test("a comment on repeated text stays put when a neighbouring copy is edited", () => {
  const anchor = anchorOn(plans, "TBD", 1);

  const v2 = render(
    "<p>Plan A: shipped 12 Oct</p><p>Plan B: TBD</p><p>Plan C: done</p>",
  );
  assert.strictEqual(landedIn(resolveAnchor(v2, anchor)), "Plan B: TBD");
});

test("a comment on repeated text survives content added above it", () => {
  const anchor = anchorOn(plans, "TBD", 1);

  const v2 = render(`<h1>Roadmap</h1>${plans}`);
  assert.strictEqual(landedIn(resolveAnchor(v2, anchor)), "Plan B: TBD");
});

const owners =
  "<p>Payments: the owner is TBD until finance replies.</p>" +
  "<p>Search: the owner is TBD until the vendor replies.</p>" +
  "<p>Notes.</p>";

test("a comment on repeated text follows its paragraph when the paragraph moves", () => {
  const anchor = anchorOn(owners, "TBD", 1); // the "TBD" in the Search paragraph

  const v2 = render(
    "<p>Payments: the owner is TBD until finance replies.</p>" +
      "<p>Notes.</p>" +
      "<p>Search: the owner is TBD until the vendor replies.</p>",
  );
  assert.strictEqual(
    landedIn(resolveAnchor(v2, anchor)),
    "Search: the owner is TBD until the vendor replies.",
  );
});

test("a unique quote still anchors after the text around it is rewritten", () => {
  const quote = "The launch date is 14 November.";
  const anchor = anchorOn(
    `<p>Old intro that was there before.</p><p>${quote}</p><p>Old closing text.</p>`,
    quote,
    0,
  );

  const v2 = render(
    `<p>Completely new intro text here.</p><p>${quote}</p><p>Totally different closing words.</p>`,
  );
  assert.strictEqual(landedIn(resolveAnchor(v2, anchor)), quote);
});

test("a comment on repeated text stays put when the text after it is rewritten", () => {
  const anchor = anchorOn(plans, "TBD", 1);

  // The quote is still at its stored offsets, so it anchors there whatever
  // the context says, as the API reports.
  const v2 = render("<p>Plan A: TBD</p><p>Plan B: TBD</p><p>X</p>");
  assert.strictEqual(landedIn(resolveAnchor(v2, anchor)), "Plan B: TBD");
});

test("a copy in a script never counts as a copy of the quote", () => {
  const anchor = anchorOn("<p>Old intro TBD old outro.</p>", "TBD", 0);

  const v2 = render(
    '<p>New words here TBD and different words.</p><script>const x = "TBD";</script>',
  );
  assert.strictEqual(
    landedIn(resolveAnchor(v2, anchor)),
    "New words here TBD and different words.",
  );
});

test("a repeated quote anchors on any copy whose context agrees, not only the nearest", () => {
  const anchor = {
    quote: "TBD",
    prefix: "Owner for the payments team: ",
    suffix: " until finance replies here.",
  };
  // The stored position is near, but not at, the first copy, whose context
  // scores just below the floor; the second copy's context clears it.
  const first = "Owner for the payment group: TBD until the vendor replies.";
  const second = "Owner for payments: TBD until finance says so.";
  const v2 = render(`<p>${first}</p><p>${second}</p>`);
  assert.strictEqual(
    landedIn(
      resolveAnchor(v2, {
        ...anchor,
        start_offset: first.indexOf("TBD") - 2,
        end_offset: first.indexOf("TBD") + 1,
      }),
    ),
    second,
  );
});
