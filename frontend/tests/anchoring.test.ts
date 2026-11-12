import { assert, test } from "vitest";

import { matchQuote } from "../bridge/anchoring/match-quote.ts";
import {
  rawOffsetToRendered,
  renderedOffsetToRaw,
} from "../bridge/anchoring/rendered-text.ts";

test("matchQuote returns null for an empty quote", () => {
  assert.strictEqual(matchQuote("some document text", ""), null);
});

test("matchQuote finds a unique exact match with score 1 and correct offsets", () => {
  const text = "Hello world, this is a test document.";
  const match = matchQuote(text, "this is a test");

  assert.ok(match);
  assert.strictEqual(match.start, text.indexOf("this is a test"));
  assert.strictEqual(match.end, match.start + "this is a test".length);
  assert.strictEqual(text.slice(match.start, match.end), "this is a test");
  assert.strictEqual(match.score, 1);
});

test("matchQuote finds a fuzzy match for a quote with typos, scoring below 1", () => {
  const text = "The quick brown fox jumps over the lazy dog while the cat sleeps.";
  // Two edits away from "quick brown fox jumps" (missing "o", swapped "mp").
  const match = matchQuote(text, "quick brwn fox jupms");

  assert.ok(match);
  const matched = text.slice(match.start, match.end);
  assert.ok(
    matched.includes("brown fox"),
    `expected match over the intended region, got "${matched}"`,
  );
  assert.ok(match.score < 1, "an inexact match must not score a perfect 1");
  assert.ok(match.score > 0.7, "a near-miss quote should still score highly");
});

test("matchQuote returns null when the quote is nowhere near the text", () => {
  // The search allows up to quote.length / 2 errors; every substring of the
  // text is more than 4 edits away from this 8-character quote.
  const text = "aaaa aaaa aaaa aaaa aaaa";
  assert.strictEqual(matchQuote(text, "zzzzzzzz"), null);
});

test("matchQuote uses prefix/suffix context to pick between duplicate occurrences", () => {
  const quote = "The result is final.";
  const text = `Alpha section. ${quote} Middle text here. Beta section. ${quote} Gamma end.`;

  const first = text.indexOf(quote);
  const second = text.indexOf(quote, first + 1);
  assert.ok(second > first, "fixture must contain the quote twice");

  const match = matchQuote(text, quote, {
    prefix: "Beta section. ",
    suffix: " Gamma end.",
  });

  assert.ok(match);
  assert.strictEqual(match.start, second);
  assert.strictEqual(match.end, second + quote.length);

  // Sanity: context for the first occurrence selects the first one.
  const firstMatch = matchQuote(text, quote, {
    prefix: "Alpha section. ",
    suffix: " Middle text",
  });
  assert.ok(firstMatch);
  assert.strictEqual(firstMatch.start, first);
});

test("matchQuote uses the position hint to break ties between identical occurrences", () => {
  const quote = "repeated sentence";
  const unit = `padding before ${quote} padding after.`;
  // Two occurrences with byte-identical surroundings: only position differs.
  const text = `${unit} ${unit}`;

  const first = text.indexOf(quote);
  const second = text.indexOf(quote, first + 1);
  assert.ok(second > first, "fixture must contain the quote twice");

  const nearSecond = matchQuote(text, quote, { hint: second });
  assert.ok(nearSecond);
  assert.strictEqual(nearSecond.start, second);
  assert.strictEqual(nearSecond.end, second + quote.length);

  const nearFirst = matchQuote(text, quote, { hint: first });
  assert.ok(nearFirst);
  assert.strictEqual(nearFirst.start, first);
});

test("renderedOffsetToRaw is identity when there are no <br> positions", () => {
  assert.strictEqual(renderedOffsetToRaw([], 0), 0);
  assert.strictEqual(renderedOffsetToRaw([], 7), 7);
});

test("renderedOffsetToRaw leaves offsets at or before a <br> untouched", () => {
  const brs = [5, 10, 20];
  assert.strictEqual(renderedOffsetToRaw(brs, 0), 0);
  assert.strictEqual(renderedOffsetToRaw(brs, 3), 3);
  // Offset 5 points at the synthesized space itself, before any raw
  // characters were skipped.
  assert.strictEqual(renderedOffsetToRaw(brs, 5), 5);
});

test("renderedOffsetToRaw subtracts one character per preceding <br>", () => {
  const brs = [5, 10, 20];
  // Just past the first synthesized space.
  assert.strictEqual(renderedOffsetToRaw(brs, 6), 5);
  // At the second br: only the first one precedes it.
  assert.strictEqual(renderedOffsetToRaw(brs, 10), 9);
  // Past the second br.
  assert.strictEqual(renderedOffsetToRaw(brs, 11), 9);
  // Past all three brs.
  assert.strictEqual(renderedOffsetToRaw(brs, 25), 22);
});

test("renderedOffsetToRaw handles consecutive <br> elements", () => {
  // Two adjacent <br>s produce back-to-back synthesized spaces.
  const brs = [4, 5];
  assert.strictEqual(renderedOffsetToRaw(brs, 4), 4);
  assert.strictEqual(renderedOffsetToRaw(brs, 5), 4);
  assert.strictEqual(renderedOffsetToRaw(brs, 6), 4);
  assert.strictEqual(renderedOffsetToRaw(brs, 9), 7);
});

test("renderedOffsetToRaw inverts rawOffsetToRendered for every raw offset", () => {
  // Note the direction: rendered->raw is lossy around a run of synthesized
  // spaces (several rendered offsets collapse onto one raw offset), so only
  // raw->rendered->raw is a true round-trip.
  for (const brPositions of [[], [5, 10, 20], [4, 5], [0]]) {
    for (let raw = 0; raw <= 25; raw++) {
      const rendered = rawOffsetToRendered(brPositions, raw);
      assert.strictEqual(
        renderedOffsetToRaw(brPositions, rendered),
        raw,
        `round-trip failed for raw=${raw} brs=[${brPositions}]`,
      );
    }
  }
});
