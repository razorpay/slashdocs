import { fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment } from "@/api";
import { DocProvider, type DocContextValue } from "./doc-context";
import { useCommentJumps } from "./use-comment-jumps";

afterEach(() => (document.body.innerHTML = ""));

const thread = (id: string, over: Partial<Comment> = {}) =>
  ({ id, status: "open", ...over }) as Comment;

const comments = [
  thread("late", { unread: true }),
  thread("done", { status: "resolved" }),
  thread("early"),
  thread("middle"),
];
const commentPositions = new Map([
  ["early", { top: 0, bottom: 0 }],
  ["middle", { top: 100, bottom: 100 }],
  ["late", { top: 900, bottom: 900 }],
]);

function Jumps({ ready, post }: { ready: boolean; post: () => void }) {
  useCommentJumps(ready, post);
  return null;
}

function setup(more: Partial<DocContextValue> = {}, ready = true) {
  const post = vi.fn();
  const jumpToComment = vi.fn();
  const view = (more: Partial<DocContextValue>, ready: boolean) => (
    <DocProvider
      value={{ comments, commentPositions, jumpToComment, ...more } as DocContextValue}
    >
      <Jumps ready={ready} post={post} />
    </DocProvider>
  );
  const { rerender } = render(view(more, ready));
  const pulses = () =>
    post.mock.calls.flatMap(([m]) => (m.type === "slashdocs:pulse" ? [m.id] : []));
  return {
    jump: jumpToComment,
    post,
    pulses,
    rerender: (more: Partial<DocContextValue>, ready = true) =>
      rerender(view(more, ready)),
  };
}

it("goes to the next and previous open thread in document order", () => {
  const { jump, post } = setup({ activeComment: "middle" });
  expect(post).toHaveBeenCalledWith({ type: "slashdocs:thread-keys", on: true });
  fireEvent.keyDown(document, { key: "n" });
  expect(jump).toHaveBeenLastCalledWith("late");
  fireEvent.keyDown(document, { key: "N", shiftKey: true });
  expect(jump).toHaveBeenLastCalledWith("early");
});

it("leaves J and K to scroll the document", () => {
  const { jump } = setup({ activeComment: "middle" });
  fireEvent.keyDown(document, { key: "j" });
  fireEvent.keyDown(document, { key: "k" });
  expect(jump).not.toHaveBeenCalled();
});

it("leaves the keys to fields and to keys with modifiers", () => {
  const { jump } = setup();
  const field = document.body.appendChild(document.createElement("textarea"));
  fireEvent.keyDown(field, { key: "n" });
  fireEvent.keyDown(document, { key: "N", metaKey: true });
  fireEvent.keyDown(document, { key: "n", repeat: true });
  expect(jump).not.toHaveBeenCalled();
});

it("pulses each jump once the document is ready, and only once", () => {
  const first = { id: "late" };
  const { pulses, rerender } = setup({ jump: first }, false);
  expect(pulses()).toEqual([]);
  rerender({ jump: first });
  rerender({ jump: first });
  expect(pulses()).toEqual(["late"]);
  rerender({ jump: { id: "late" } });
  expect(pulses()).toEqual(["late", "late"]);
});
