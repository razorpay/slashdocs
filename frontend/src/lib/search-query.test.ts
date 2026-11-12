import { describe, expect, it } from "vitest";
import {
  hasDocumentSearchOperators,
  replaceSearchToken,
  searchTokenAt,
  searchTokens,
} from "./search-query";

describe("document search query helpers", () => {
  it("splits outside quotes and marks known modifiers", () => {
    expect(searchTokens('plan in:"Product Specs" -"old plan" status:x')).toEqual([
      { start: 0, end: 4, text: "plan", value: "plan", key: undefined },
      {
        start: 5,
        end: 23,
        text: 'in:"Product Specs"',
        key: "in",
        value: "Product Specs",
      },
      { start: 24, end: 35, text: '-"old plan"', value: "-old plan", key: undefined },
      { start: 36, end: 44, text: "status:x", value: "status:x", key: undefined },
    ]);
    expect(searchTokens('in:"Product Sp')[0]).toMatchObject({
      key: "in",
      value: "Product Sp",
    });
  });

  it("runs a date over the next date words", () => {
    expect(searchTokens("after:last week budget").map((t) => t.text)).toEqual([
      "after:last week",
      "budget",
    ]);
    expect(searchTokens("on:5th sept, 2025 plan")[0]).toMatchObject({
      key: "on",
      value: "5th sept, 2025",
    });
    expect(searchTokenAt("after:last we", 13)).toMatchObject({
      key: "after",
      value: "last we",
    });
  });

  it("finds the token at the cursor, or an empty one between tokens", () => {
    expect(searchTokenAt("incident from:ali", 17)).toMatchObject({
      key: "from",
      value: "ali",
    });
    expect(searchTokenAt("incident ", 9)).toEqual({
      start: 9,
      end: 9,
      text: "",
      value: "",
    });
  });

  it("detects queries that are more than folder title text", () => {
    expect(hasDocumentSearchOperators("incident from:me")).toBe(true);
    expect(hasDocumentSearchOperators('"exact phrase"')).toBe(true);
    expect(hasDocumentSearchOperators("plan -draft")).toBe(true);
    expect(hasDocumentSearchOperators("plain title - notes")).toBe(false);
  });

  it("replaces the token and ends a finished modifier with a space", () => {
    const query = "incident from:ali in:x";
    expect(
      replaceSearchToken(query, searchTokenAt(query, 17), "from:alice@example.com"),
    ).toEqual({ value: "incident from:alice@example.com in:x", cursor: 31 });
    expect(replaceSearchToken("fr", searchTokenAt("fr", 2), "from:")).toEqual({
      value: "from:",
      cursor: 5,
    });
  });
});
