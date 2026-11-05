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

it("offers Retry when the settings do not load, in the profile and in a document", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fail
        ? new Response(JSON.stringify({ error: { message: "down" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ enabled: true, effective_enabled: true }), {
            headers: { "Content-Type": "application/json" },
          }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationToggle />
      <NotificationToggle documentId="doc_1" />
    </QueryClientProvider>,
  );

  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByText("Could not load your notification settings.")).toBeVisible();
  const docRetry = await screen.findByRole("button", {
    name: "Notification settings did not load. Retry",
  });
  fail = false;
  await userEvent.click(retry);
  await userEvent.click(docRetry);
  expect(
    await screen.findByRole("switch", { name: "Chat notifications" }),
  ).toBeChecked();
  expect(
    await screen.findByRole("switch", { name: "Notifications for this document" }),
  ).toBeChecked();
});

it("saves the last choice when an earlier write ends after a later click", async () => {
  let saved = false;
  let release: () => void = () => {};
  const writes: boolean[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const { enabled } = JSON.parse(String(init.body));
        writes.push(enabled);
        if (writes.length === 1) await new Promise<void>((r) => (release = r));
        saved = enabled;
      }
      return new Response(
        JSON.stringify({ enabled: saved, effective_enabled: saved }),
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
  const toggle = screen.getByRole("switch", { name: "Chat notifications" });
  await waitFor(() => expect(toggle).toBeEnabled());
  await userEvent.click(toggle);
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-checked", "false");
  release();
  await waitFor(() => expect(writes).toEqual([true, false]));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(saved).toBe(false);
  expect(toggle).toHaveAttribute("aria-checked", "false");
});
