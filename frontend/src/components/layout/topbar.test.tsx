import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountMenu, GetStarted } from "./topbar";

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
