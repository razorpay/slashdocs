import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useRefreshLists } from "./use-refresh-lists";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const hook = renderHook(() => useRefreshLists("doc_1"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  // The count of refreshes of the list of versions.
  const refreshes = () =>
    invalidate.mock.calls.filter(
      ([filters]) => String(filters?.queryKey) === String(queryKeys.versions("doc_1")),
    ).length;
  return { hook, invalidate, refreshes, refresh: hook.result.current };
}

it("refreshes the versions, the approvals and the document lists", () => {
  const { refresh, invalidate } = setup();

  refresh();

  expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
    expect.arrayContaining([
      queryKeys.versions("doc_1"),
      queryKeys.approvalsAll("doc_1"),
      queryKeys.document("doc_1"),
      queryKeys.documents(),
    ]),
  );
});

it("refreshes at once for the first change, then at most each 2 s, and for the last change", () => {
  const { refresh, refreshes } = setup();

  refresh();
  expect(refreshes()).toBe(1);
  // Live typing makes a change each 300 ms.
  for (let i = 0; i < 6; i++) {
    vi.advanceTimersByTime(300);
    refresh();
  }
  expect(refreshes()).toBe(1);
  vi.advanceTimersByTime(200);
  expect(refreshes()).toBe(2);
  // No change came after the last refresh.
  vi.advanceTimersByTime(10_000);
  expect(refreshes()).toBe(2);
});

it("runs the refresh that waits when the page goes", () => {
  const { hook, refresh, refreshes } = setup();

  refresh();
  refresh();
  hook.unmount();

  expect(refreshes()).toBe(2);
});
