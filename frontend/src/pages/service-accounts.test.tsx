import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceAccountsPage } from "./service-accounts";

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <MemoryRouter>
          <ServiceAccountsPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

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

  it("names the bot name field, and ties its hint and error to it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({ items: [] });
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
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveAccessibleDescription(/Letters, numbers, and hyphens/);
    expect(name).not.toBeInvalid();

    await user.type(name, "n8n@ops.team");
    expect(name).toBeInvalid();
    expect(name).toHaveAccessibleDescription(/Addresses must end in/);
  });

  it("offers Retry when the bots do not load, and no selection prompt", async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(api, "listServiceAccounts")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ items: [] });
    renderPage();

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText("No bot selected")).not.toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText(/No bots yet/)).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("offers Retry when the keys of a bot do not load", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({
      items: [{ id: "sa_1", name: "n8n@bots.bot" }],
    } as Awaited<ReturnType<typeof api.listServiceAccounts>>);
    const keys = vi
      .spyOn(api, "listServiceAccountKeys")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ items: [] });
    renderPage();

    expect(await screen.findByText("Could not load keys")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No keys yet/)).toBeInTheDocument();
    expect(keys).toHaveBeenCalledTimes(2);
  });

  it("names each Revoke button by its key", async () => {
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({
      items: [{ id: "sa_1", name: "n8n@bots.bot" }],
    } as Awaited<ReturnType<typeof api.listServiceAccounts>>);
    vi.spyOn(api, "listServiceAccountKeys").mockResolvedValue({
      items: [
        { id: "key_1", name: "First key" },
        { id: "key_2", name: "Second review key" },
      ],
    } as Awaited<ReturnType<typeof api.listServiceAccountKeys>>);
    renderPage();

    expect(
      await screen.findByRole("button", { name: "Revoke key Second review key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke key First key" }),
    ).toBeInTheDocument();
  });
  it("shows the key of a new bot that answers after Cancel", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({ items: [] });
    let answer!: (r: Awaited<ReturnType<typeof api.createServiceAccount>>) => void;
    vi.spyOn(api, "createServiceAccount").mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );
    renderPage();

    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(screen.getByRole("textbox"), "n8n");
    await user.click(screen.getByRole("button", { name: "Create bot" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    answer({
      id: "sa_1",
      label: "n8n",
      name: "n8n@bots.bot",
      key: { id: "key_1", token: "sd_secret" },
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("sd_secret")).toBeInTheDocument();
    expect(within(dialog).getAllByText("n8n@bots.bot").length).toBeGreaterThan(0);
  });

  it("shows a new key under the bot and name it was sent for", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({
      items: [
        { id: "sa_a", name: "alpha@bots.bot" },
        { id: "sa_b", name: "beta@bots.bot" },
      ],
    } as Awaited<ReturnType<typeof api.listServiceAccounts>>);
    vi.spyOn(api, "listServiceAccountKeys").mockResolvedValue({ items: [] });
    let answer!: (r: Awaited<ReturnType<typeof api.createServiceAccountKey>>) => void;
    const create = vi
      .spyOn(api, "createServiceAccountKey")
      .mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderPage();

    const field = await screen.findByPlaceholderText("Key name");
    await user.type(field, "FIRST KEY");
    await user.click(screen.getByRole("button", { name: "New key" }));
    await user.clear(field);
    await user.type(field, "SECOND UNSENT");
    await user.click(screen.getByRole("button", { name: /beta@bots\.bot/ }));

    answer({ id: "key_1", token: "sd_secret" } as Awaited<
      ReturnType<typeof api.createServiceAccountKey>
    >);
    const dialog = await screen.findByRole("dialog");
    expect(create).toHaveBeenCalledWith("sa_a", "FIRST KEY");
    expect(within(dialog).getByText("FIRST KEY")).toBeInTheDocument();
    expect(within(dialog).getAllByText("alpha@bots.bot").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/SECOND UNSENT|beta@bots\.bot/)).toBeNull();
  });
});
