import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast, type Action } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Comment } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { CHECK_MS, LEAVE_MS, useResolveThread } from "./use-resolve-thread";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const key = queryKeys.comments("doc_1");

function setup() {
  const patch = vi.spyOn(api, "patchComment").mockResolvedValue({} as Comment);
  const client = new QueryClient();
  client.setQueryData(key, { items: [{ id: "c1", status: "open" } as Comment] });
  let active: string | undefined = "c1";
  const setActive = vi.fn((next) => {
    active = typeof next === "function" ? next(active) : next;
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useResolveThread("doc_1", setActive), { wrapper });
  const status = () => client.getQueryData<{ items: Comment[] }>(key)?.items[0].status;
  return { ...view, patch, status, active: () => active };
}

it("draws the check, lets the thread leave, then resolves it with an Undo", async () => {
  const { result, patch, status, active } = setup();
  act(() => void result.current.resolveThread("c1"));
  expect(patch).toHaveBeenCalledWith("doc_1", "c1", { status: "resolved" });
  expect(active()).toBe("c1");

  await act(() => vi.advanceTimersByTimeAsync(CHECK_MS));
  expect(result.current.leaving).toBe("c1");
  expect(active()).toBeUndefined();
  expect(status()).toBe("open");
  expect(toast).toHaveBeenCalledWith(
    "Resolved",
    expect.objectContaining({ duration: 5000, action: expect.anything() }),
  );

  await act(() => vi.advanceTimersByTimeAsync(LEAVE_MS));
  expect(result.current.leaving).toBeUndefined();
  expect(status()).toBe("resolved");
});

it("reopens the thread and opens it again on Undo", async () => {
  const { result, patch, status, active } = setup();
  act(() => void result.current.resolveThread("c1"));
  await act(() => vi.advanceTimersByTimeAsync(CHECK_MS + LEAVE_MS));
  const [, options] = vi.mocked(toast).mock.lastCall!;
  await act(async () => {
    (options!.action as Action).onClick({} as never);
  });
  expect(status()).toBe("open");
  expect(active()).toBe("c1");
  expect(patch).toHaveBeenLastCalledWith("doc_1", "c1", { status: "open" });
});
