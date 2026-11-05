import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCommentDrafts,
  keepPendingComment,
  readEdit,
  setEdit,
  takePendingComment,
  unsentText,
  useCommentDrafts,
  useDraftText,
  useReplyDraft,
  type CommentDraft,
  type DraftText,
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

describe("useReplyDraft", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a reply per document and thread, and drops it when emptied", () => {
    const a = renderHook(() => useReplyDraft("doc_a", "cmt_1"));
    const b = renderHook(() => useReplyDraft("doc_a", "cmt_2"));
    act(() => a.result.current[1]({ body: "Agreed", mentions: [] }));
    expect(a.result.current[0]).toMatchObject({ body: "Agreed" });
    expect(b.result.current[0]).toBeUndefined();

    act(() => a.result.current[1]({ body: "  ", mentions: [] }));
    expect(a.result.current[0]).toBeUndefined();
    expect(localStorage.getItem("slashdocs.reply-drafts")).toBe("{}");
  });

  it("forgets every reply on clear", () => {
    const { result } = renderHook(() => useReplyDraft("doc_a", "cmt_1"));
    act(() => result.current[1]({ body: "Agreed", mentions: [] }));
    act(() => clearCommentDrafts());
    expect(result.current[0]).toBeUndefined();
  });
});

describe("takePendingComment", () => {
  beforeEach(() => localStorage.clear());

  it("gives the comment that waits for a document once", () => {
    const pending = { docId: "doc_a", version: "ver_1", selection: { quote: "text" } };
    keepPendingComment(pending);
    expect(takePendingComment("doc_b")).toBeNull();
    keepPendingComment(pending);
    expect(takePendingComment("doc_a")).toEqual(pending);
    expect(takePendingComment("doc_a")).toBeNull();
  });
});

describe("useDraftText", () => {
  it("saves after a pause, and at once when the field closes", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDraftText({ body: "", mentions: [] }, save),
    );
    act(() => result.current[1]({ body: "a", mentions: [] }));
    act(() => result.current[1]({ body: "ab", mentions: [] }));
    expect(result.current[0].body).toBe("ab");
    expect(save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(save).toHaveBeenCalledExactlyOnceWith({ body: "ab", mentions: [] });

    act(() => result.current[1]({ body: "abc", mentions: [] }));
    unmount();
    expect(save).toHaveBeenLastCalledWith({ body: "abc", mentions: [] });
    vi.useRealTimers();
  });
});

describe("unsentText", () => {
  const mention = (offset: number) => ({
    principal: { type: "user" as const, id: "u2" },
    offset,
    length: 4,
  });
  const sent = { body: "Fix this", mentions: [] };

  it("leaves nothing when the field still holds the sent text", () => {
    expect(unsentText(sent, sent)).toEqual({ body: "", mentions: [] });
  });

  it("leaves the words typed after the sent text, with their mentions", () => {
    const now = { body: "Fix this  @Bo, today", mentions: [mention(10)] };
    expect(unsentText(now, sent)).toEqual({
      body: "@Bo, today",
      mentions: [mention(0)],
    });
  });

  it("leaves all of the field when the sent words changed", () => {
    const now = { body: "Fix that too", mentions: [] };
    expect(unsentText(now, sent)).toBe(now);
  });
});

describe("useDraftText edit", () => {
  it("takes a function of the text now, and gives back the new text", () => {
    const { result } = renderHook(() =>
      useDraftText({ body: "a", mentions: [] }, vi.fn()),
    );
    let next;
    act(() => {
      result.current[1]({ body: "ab", mentions: [] });
      next = result.current[1]((now) => ({ ...now, body: now.body + "c" }));
    });
    expect(next).toEqual({ body: "abc", mentions: [] });
    expect(result.current[0].body).toBe("abc");
  });
});

describe("useDraftText conflict", () => {
  const text = (body: string) => ({ body, mentions: [] });

  it("keeps both texts when the field closes before the reader chooses, and shows them again", () => {
    const save = vi.fn();
    const first = renderHook(({ stored }) => useDraftText(stored, save), {
      initialProps: { stored: text("BASE") },
    });
    act(() => void first.result.current[1](text("LOCAL WORDS")));
    first.rerender({ stored: text("OTHER TAB WORDS") });
    expect(first.result.current[2]?.theirs.body).toBe("OTHER TAB WORDS");
    first.unmount();
    // The newer stored text stays, and the reader's words wait beside it.
    expect(save).toHaveBeenLastCalledWith({
      ...text("OTHER TAB WORDS"),
      held: text("LOCAL WORDS"),
    });

    const again = renderHook(() => useDraftText(save.mock.lastCall![0], save));
    expect(again.result.current[0].body).toBe("LOCAL WORDS");
    expect(again.result.current[2]?.theirs.body).toBe("OTHER TAB WORDS");
    act(() => again.result.current[2]!.keep());
    expect(save).toHaveBeenLastCalledWith(text("LOCAL WORDS"));
    expect(again.result.current[2]).toBeUndefined();
  });

  it("clears the waiting text when the reader takes the new one", () => {
    const save = vi.fn();
    const { result } = renderHook(() =>
      useDraftText({ ...text("THEIRS"), held: text("MINE") }, save),
    );
    act(() => result.current[2]!.take());
    expect(result.current[0].body).toBe("THEIRS");
    expect(save).toHaveBeenLastCalledWith(text("THEIRS"));
  });

  it("keeps a waiting text when another open field saves the same draft", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ stored }) => useDraftText(stored, save),
      {
        initialProps: { stored: text("THEIRS") as DraftText },
      },
    );
    rerender({ stored: { ...text("THEIRS"), held: text("MINE") } });
    act(() => void result.current[1](text("THEIRS AND MORE")));
    act(() => vi.advanceTimersByTime(300));
    expect(save).toHaveBeenLastCalledWith({
      ...text("THEIRS AND MORE"),
      held: text("MINE"),
    });
    vi.useRealTimers();
  });
});

describe("setEdit", () => {
  beforeEach(() => localStorage.clear());

  it("keeps an unsent edit per document in storage, so that it outlives a reload", () => {
    const edit = { thread: "cmt_1", base: "Old", body: "Old and new", mentions: [] };
    act(() => setEdit("doc_a", "cmt_1", edit));
    expect(readEdit("doc_a", "cmt_1")).toMatchObject(edit);
    expect(readEdit("doc_b", "cmt_1")).toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem("slashdocs.comment-edits")!).doc_a.cmt_1,
    ).toMatchObject({ body: "Old and new" });
    act(() => setEdit("doc_a", "cmt_1"));
    expect(readEdit("doc_a", "cmt_1")).toBeUndefined();
  });

  it("forgets every edit on clear", () => {
    setEdit("doc_a", "cmt_1", { thread: "cmt_1", base: "a", body: "b", mentions: [] });
    clearCommentDrafts();
    expect(readEdit("doc_a", "cmt_1")).toBeUndefined();
  });
});
