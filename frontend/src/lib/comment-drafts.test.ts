import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommentDrafts,
  useCommentDrafts,
  type CommentDraft,
} from "./comment-drafts";

const KEY = "slashdocs.comment-drafts";
const draft = (id: string, updatedAt = Date.now()): CommentDraft => ({
  id,
  version: "ver_1",
  quote: "text",
  body: "body",
  mentions: [],
  updatedAt,
});

describe("useCommentDrafts", () => {
  beforeEach(() => localStorage.clear());

  it("keeps drafts per document and drops the key of an empty document", () => {
    const a = renderHook(() => useCommentDrafts("doc_a"));
    const b = renderHook(() => useCommentDrafts("doc_b"));
    act(() => a.result.current[1](() => [draft("draft:1"), draft("draft:2")]));
    act(() => b.result.current[1](() => [draft("draft:3")]));
    expect(a.result.current[0].map((d) => d.id)).toEqual(["draft:1", "draft:2"]);
    expect(b.result.current[0].map((d) => d.id)).toEqual(["draft:3"]);

    act(() => b.result.current[1](() => []));
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(["doc_a"]);
  });

  it("drops drafts older than 30 days", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      KEY,
      JSON.stringify({ doc_a: [draft("draft:old", old), draft("draft:new")] }),
    );
    const { result } = renderHook(() => useCommentDrafts("doc_a"));
    expect(result.current[0].map((d) => d.id)).toEqual(["draft:new"]);
  });

  it("forgets every draft on clear", () => {
    const { result } = renderHook(() => useCommentDrafts("doc_a"));
    act(() => result.current[1](() => [draft("draft:1")]));
    act(() => clearCommentDrafts());
    expect(result.current[0]).toEqual([]);
  });
});
