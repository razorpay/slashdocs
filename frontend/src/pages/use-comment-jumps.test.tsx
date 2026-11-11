import type { ReactNode } from "react";
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment } from "@/api";
import { DocProvider, type DocContextValue } from "./doc-context";
import { useCommentJumps } from "./use-comment-jumps";

afterEach(() => (document.body.innerHTML = ""));

const thread = (id: string, over: Partial<Comment> = {}) =>
  ({ id, status: "open", ...over }) as Comment;

function setup(active?: string) {
  const ctx = {
    comments: [
      thread("late", { unread: true }),
      thread("done", { status: "resolved" }),
      thread("early"),
      thread("middle"),
    ],
    commentPositions: new Map([
      ["early", { top: 0, bottom: 0 }],
      ["middle", { top: 100, bottom: 100 }],
      ["late", { top: 900, bottom: 900 }],
    ]),
    activeComment: active,
    jumpToComment: vi.fn(),
  } as unknown as DocContextValue;
  const post = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DocProvider value={ctx}>{children}</DocProvider>
  );
  renderHook(() => useCommentJumps(true, post), { wrapper });
  return { jump: ctx.jumpToComment, post };
}

it("goes to the next and previous open thread in document order", () => {
  const { jump, post } = setup("middle");
  expect(post).toHaveBeenCalledWith({ type: "slashdocs:thread-keys", on: true });
  fireEvent.keyDown(document, { key: "j" });
  expect(jump).toHaveBeenLastCalledWith("late");
  fireEvent.keyDown(document, { key: "p" });
  expect(jump).toHaveBeenLastCalledWith("early");
  fireEvent.keyDown(document, { key: "J", shiftKey: true });
  expect(jump).toHaveBeenLastCalledWith("late");
});

it("leaves the keys to fields and to keys with modifiers", () => {
  const { jump } = setup();
  const field = document.body.appendChild(document.createElement("textarea"));
  fireEvent.keyDown(field, { key: "j" });
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  fireEvent.keyDown(document, { key: "n", repeat: true });
  expect(jump).not.toHaveBeenCalled();
});
