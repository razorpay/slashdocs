import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationToggle } from "./notification-toggle";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The server has notifications off and fails to save a change.
function renderToggle() {
  let failSave: () => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await new Promise<void>((resolve) => (failSave = resolve));
        return new Response(JSON.stringify({ error: { message: "down" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ enabled: false, effective_enabled: false }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NotificationToggle />
    </QueryClientProvider>,
  );
  return () => failSave();
}

it("moves the switch at once, and back when the save fails", async () => {
  const failSave = renderToggle();
  const toggle = screen.getByRole("switch", { name: "Chat notifications" });
  await waitFor(() => expect(toggle).toBeEnabled());
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toBeEnabled();
  failSave();
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
});
