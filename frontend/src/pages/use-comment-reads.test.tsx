import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Comment } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { useCommentReads } from "./use-comment-reads";

afterEach(() => vi.restoreAllMocks());

const thread = (id: string, unread = true) => ({ id, unread }) as unknown as Comment;
const key = queryKeys.comments("doc_1");

function setup(items: Comment[], active?: string) {
  const mark = vi.spyOn(api, "markCommentRead").mockResolvedValue(undefined);
  const client = new QueryClient();
  client.setQueryData(key, { items });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ open }) =>
      useCommentReads(
        "doc_1",
        useQuery({ queryKey: key, queryFn: () => new Promise<never>(() => {}) }),
        open,
      ),
    { wrapper, initialProps: { open: active } },
  );
  const unread = () => view.result.current.comments.map((c) => !!c.unread);
  // The query tells its observers after a tick.
  const reply = (next: Comment[]) =>
    act(async () => {
      client.setQueryData(key, { items: next });
      await new Promise((resolve) => setTimeout(resolve));
    });
  return { ...view, client, mark, unread, reply };
}

it("marks the open thread read once its popover read it", () => {
  const { result, mark, unread, client } = setup([thread("a"), thread("b")], "a");
  expect(unread()).toEqual([true, true]);
  act(() => result.current.readThread("a"));
  expect(unread()).toEqual([false, true]);
  expect(mark).toHaveBeenCalledExactlyOnceWith("doc_1", "a");
  expect(client.getQueryData<{ items: Comment[] }>(key)?.items[0].unread).toBe(false);
});

it("keeps the open thread read when a live reply comes into it", async () => {
  const { result, mark, unread, reply } = setup([thread("a")], "a");
  act(() => result.current.readThread("a"));
  mark.mockClear();
  await reply([thread("a")]);
  expect(unread()).toEqual([false]);
  expect(mark).toHaveBeenCalledExactlyOnceWith("doc_1", "a");
});

it("shows a live reply to a closed thread as unread", async () => {
  const { result, mark, unread, rerender, reply } = setup([thread("a")], "a");
  act(() => result.current.readThread("a"));
  rerender({ open: undefined });
  mark.mockClear();
  await reply([thread("a")]);
  expect(unread()).toEqual([true]);
  expect(mark).not.toHaveBeenCalled();
});

it("makes no call for a reader with no unread threads, as a signed-out one", () => {
  const { result, mark } = setup([thread("a", false)], "a");
  act(() => result.current.readThread("a"));
  expect(mark).not.toHaveBeenCalled();
});
