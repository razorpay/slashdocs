import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessRequestsMenu, AccountMenu, GetStarted } from "./topbar";

describe("AccountMenu", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("opens the setup guide and keeps its progress", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "slashdocs.onboarding",
      JSON.stringify({ status: "active", path: "cli", steps: { cli_installed: true } }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/app/documents"]}>
            <Routes>
              <Route
                path="/app/documents"
                element={<AccountMenu user={{ type: "user", id: "usr_1" }} />}
              />
              <Route path="/app/start" element={<GetStarted />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Setup guide" }));

    expect(
      await screen.findByRole("link", { name: "Get started: 1 of 2 complete" }),
    ).toBeInTheDocument();
  });
});

function Location() {
  const { pathname, search } = useLocation();
  return <p>{pathname + search}</p>;
}

describe("AccessRequestsMenu", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the requests across documents and opens the share sheet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  document_id: "doc_1",
                  document_title: "Plan",
                  requester: { type: "user", id: "usr_ana", name: "Ana" },
                  requested_at: new Date().toISOString(),
                },
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/app/documents"]}>
            <Routes>
              <Route path="/app/documents" element={<AccessRequestsMenu />} />
              <Route path="/app/d/:id" element={<Location />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "1 request for access" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Ana asks for Plan/ }),
    );
    expect(await screen.findByText("/app/d/doc_1?share=1")).toBeInTheDocument();
  });

  it("marks a list that did not load, and loads it on Retry", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? new Response(JSON.stringify({ error: { code: "unavailable" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(
              JSON.stringify({
                items: [
                  {
                    document_id: "doc_1",
                    document_title: "Plan",
                    requester: { type: "user", id: "usr_ana", name: "Ana" },
                    requested_at: new Date().toISOString(),
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
      ),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TooltipProvider>
          <MemoryRouter>
            <AccessRequestsMenu />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Requests for access did not load" }),
    );
    expect(screen.getByText("Could not load the requests for access.")).toBeVisible();
    fail = false;
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(
      await screen.findByRole("menuitem", { name: /Ana asks for Plan/ }),
    ).toBeVisible();
    // The open menu hides the rest of the page from the accessibility tree.
    expect(
      screen.getByRole("button", { name: "1 request for access", hidden: true }),
    ).toBeVisible();
  });
});
