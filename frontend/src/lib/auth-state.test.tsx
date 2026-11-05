import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useAccountSync, useSignOut } from "./auth-state";
import { readFieldDraft, saveFieldDraft } from "./field-drafts";
import { clearOneTimeKeys, keepOneTimeKey, useOneTimeKeys } from "./one-time-keys";

// Another tab of the app, on the same channel.
const otherTab = new BroadcastChannel("slashdocs.account");

afterEach(() => {
  cleanup();
  clearOneTimeKeys();
  vi.restoreAllMocks();
});

function renderTab() {
  vi.spyOn(api, "me").mockResolvedValue({
    principal: { type: "user", id: "admin" },
  } as Awaited<ReturnType<typeof api.me>>);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/app/settings/bots"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return renderHook(
    () => {
      useAccountSync();
      return {
        keys: useOneTimeKeys(),
        path: useLocation().pathname,
        signOut: useSignOut(),
      };
    },
    { wrapper },
  );
}

it("tells the other tabs the account that it shows", async () => {
  const heard = vi.fn();
  otherTab.addEventListener("message", ({ data }) => heard(data));
  renderTab();
  await waitFor(() => expect(heard).toHaveBeenCalledWith("admin"));
});

it.each([
  ["a sign-out", null],
  ["a sign-in as someone else", "reviewer"],
])("ends its session after %s in another tab", async (_, account) => {
  const { result } = renderTab();
  await act(() =>
    keepOneTimeKey(Promise.resolve("sd_admin"), (token) => ({ bot: "a@b.bot", token })),
  );
  saveFieldDraft("bot-name", "admin words");
  await waitFor(() => expect(api.me).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));

  otherTab.postMessage(account);
  await waitFor(() => expect(result.current.keys).toEqual([]));
  expect(result.current.path).toBe("/");
  expect(readFieldDraft("bot-name")).toBeUndefined();
});

it("tells the other tabs of a sign-out", async () => {
  vi.spyOn(api, "logout").mockResolvedValue(undefined as never);
  const heard = vi.fn();
  otherTab.addEventListener("message", ({ data }) => heard(data));
  const { result } = renderTab();
  await act(() => result.current.signOut.mutateAsync());
  await waitFor(() => expect(heard).toHaveBeenCalledWith(null));
});
