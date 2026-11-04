import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceAccountsPage } from "./service-accounts";

describe("ServiceAccountsPage", () => {
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

  it("starts each new bot from an empty form, after Done", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({ items: [] });
    vi.spyOn(api, "createServiceAccount").mockResolvedValue({
      id: "sa_1",
      label: "n8n",
      name: "n8n@bots.bot",
      key: { id: "key_1", token: "sd_secret" },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter>
            <ServiceAccountsPage />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(screen.getByRole("textbox"), "n8n");
    await user.click(screen.getByRole("button", { name: "Create bot" }));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New bot" }));
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("sd_secret")).not.toBeInTheDocument();
  });
});
