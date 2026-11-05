import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./app-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("says that the workspace did not load, not a blank page, and loads it on Retry", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      fail
        ? new Response(JSON.stringify({ error: { code: "unavailable" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(
            JSON.stringify(
              String(input) === "/v1/me"
                ? { principal: { type: "user", id: "usr_1" }, user: { id: "usr_1" } }
                : { items: [] },
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/app/documents"]}>
          <Routes>
            <Route path="/app" element={<AppShell />}>
              <Route path="documents" element={<p>Documents page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Could not load your workspace")).toBeVisible();
  // The reader keeps the bar with the logo, and a way out.
  expect(screen.getByRole("link", { name: "slashdocs home" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Documents page")).toBeVisible();
});
