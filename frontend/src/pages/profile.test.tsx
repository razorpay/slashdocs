import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilePage } from "./profile";

describe("ProfilePage", () => {
  beforeEach(() => {
    // jsdom has no media queries.
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList;
  });
  afterEach(cleanup);

  it("shows a failed GitHub status as unknown, with Retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "me").mockResolvedValue({
      principal: { type: "user", id: "u_1", name: "Asha" },
    });
    vi.spyOn(api, "notificationPreferences").mockResolvedValue({
      enabled: true,
      effective_enabled: true,
    });
    const status = vi
      .spyOn(api, "githubStatus")
      .mockRejectedValueOnce(new APIError(503, "unavailable", "Service unavailable"))
      .mockResolvedValue({ configured: true, connected: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter>
            <ProfilePage />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Could not check the connection. Service unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect GitHub" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeEnabled();
    expect(status).toHaveBeenCalledTimes(2);
  });
});
