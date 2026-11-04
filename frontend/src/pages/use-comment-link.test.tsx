import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment } from "@/api";
import { useCommentLink } from "./use-comment-link";

vi.mock("sonner", () => ({ toast: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const thread = (id: string) => ({ id, replies: [] }) as unknown as Comment;

function setup(cached: Comment[], link: string) {
  const client = new QueryClient();
  client.setQueryData(["comments"], { items: cached });
  let finish: (items: Comment[]) => void = () => {};
  const fetched = new Promise<{ items: Comment[] }>((resolve) => {
    finish = (items) => resolve({ items });
  });
  const open = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[`/d/doc_1?comment=${link}`]}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  renderHook(
    () =>
      useCommentLink(
        "doc_1",
        useQuery({ queryKey: ["comments"], queryFn: () => fetched }),
        open,
      ),
    { wrapper },
  );
  return { open, finish: (items: Comment[]) => act(async () => finish(items)) };
}

it("waits for fresh comments when the cached ones lack the linked thread", async () => {
  const { open, finish } = setup([thread("cmt_old")], "cmt_new");
  expect(open).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  await finish([thread("cmt_old"), thread("cmt_new")]);
  await waitFor(() => expect(open).toHaveBeenCalledWith("cmt_new"));
  expect(toast).not.toHaveBeenCalled();
});

it("says that a linked thread is gone once fresh comments lack it too", async () => {
  const { open, finish } = setup([thread("cmt_old")], "cmt_gone");
  await finish([thread("cmt_old")]);
  expect(open).not.toHaveBeenCalled();
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
});
