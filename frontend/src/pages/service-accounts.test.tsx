import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { AppShell } from "@/components/layout/app-shell";
import { OneTimeKeyDialog } from "@/components/one-time-key-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearFieldDrafts, saveFieldDraft } from "@/lib/field-drafts";
import { clearOneTimeKeys } from "@/lib/one-time-keys";
import { ServiceAccountsPage } from "./service-accounts";

// The Copy button of the code block that shows text.
async function copyButtonOf(text: string) {
  const block = (await screen.findByText(text)).parentElement!;
  return within(block).getByRole("button", { name: "Copy" });
}

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <MemoryRouter>
          <ServiceAccountsPage />
          <OneTimeKeyDialog />
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
  afterEach(() => {
    cleanup();
    clearOneTimeKeys();
    clearFieldDrafts();
  });

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
            <OneTimeKeyDialog />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(screen.getByRole("textbox"), "n8n");
    await user.click(screen.getByRole("button", { name: "Create bot" }));
    await user.click(await copyButtonOf("sd_secret"));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New bot" }));
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("sd_secret")).not.toBeInTheDocument();
  });

  it("shows both names of a two-tab conflict, and creates no bot until the reader chooses", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({ items: [] });
    renderPage();
    await user.click(screen.getByRole("button", { name: "New bot" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "r11-local");
    // Another tab saves the same draft first.
    act(() => saveFieldDraft("bot-name", "r11-other"));

    expect(
      await screen.findByText("This draft changed in another tab. It now says:"),
    ).toBeInTheDocument();
    expect(screen.getByText("r11-other")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("r11-local");
    expect(screen.getByRole("button", { name: "Create bot" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use the new text" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("r11-other");
    expect(screen.getByRole("button", { name: "Create bot" })).toBeEnabled();
  });

  it("names the bot name field, and ties its hint and error to it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({ items: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter>
            <ServiceAccountsPage />
            <OneTimeKeyDialog />
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
    await user.click(screen.getByRole("button", { name: /^beta/ }));
    // The unsent name stays with alpha.
    expect(await screen.findByPlaceholderText("Key name")).toHaveValue("");

    answer({ id: "key_1", token: "sd_secret" } as Awaited<
      ReturnType<typeof api.createServiceAccountKey>
    >);
    const dialog = await screen.findByRole("dialog");
    expect(create).toHaveBeenCalledWith("sa_a", "FIRST KEY");
    expect(within(dialog).getByText("FIRST KEY")).toBeInTheDocument();
    expect(within(dialog).getAllByText("alpha@bots.bot").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/SECOND UNSENT|beta@bots\.bot/)).toBeNull();
    await user.click(await copyButtonOf("sd_secret"));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: /^alpha/ }));
    expect(await screen.findByPlaceholderText("Key name")).toHaveValue("SECOND UNSENT");
  });
});

// The app as the reader moves in it: the shell, the Bots page and other pages.
function renderApp() {
  let go!: (to: string) => void;
  function Navigator() {
    go = useNavigate();
    return null;
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <MemoryRouter initialEntries={["/app/settings/service-accounts"]}>
          <Navigator />
          <Routes>
            <Route path="/app" element={<AppShell />}>
              <Route
                path="settings/service-accounts"
                element={<ServiceAccountsPage />}
              />
              <Route path="settings/profile" element={<p>Profile page</p>} />
              <Route path="documents" element={<p>Documents page</p>} />
              <Route path="d/:id" element={<p>A document</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return (to: string) => act(() => go(to));
}

describe("one-time keys after the reader leaves Bots", () => {
  beforeEach(() => {
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList;
    vi.spyOn(api, "me").mockResolvedValue({
      principal: { type: "user", id: "usr_1" },
      user: { type: "user", id: "usr_1", email: "a@example.com" },
    } as Awaited<ReturnType<typeof api.me>>);
    vi.spyOn(api, "managedAccessRequests").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({
      items: [{ id: "sa_a", name: "alpha@bots.bot" }],
    } as Awaited<ReturnType<typeof api.listServiceAccounts>>);
    vi.spyOn(api, "listServiceAccountKeys").mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearOneTimeKeys();
    clearFieldDrafts();
  });

  it.each([
    ["Profile", "/app/settings/profile", "Profile page"],
    ["Documents", "/app/documents", "Documents page"],
    ["a document", "/app/d/doc_2", "A document"],
  ])("shows a key that comes after the reader went to %s", async (_, to, page) => {
    const user = userEvent.setup();
    let answer!: (r: Awaited<ReturnType<typeof api.createServiceAccountKey>>) => void;
    vi.spyOn(api, "createServiceAccountKey").mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );
    const go = renderApp();

    await user.type(await screen.findByPlaceholderText("Key name"), "HELD KEY");
    await user.click(screen.getByRole("button", { name: "New key" }));
    go(to);
    expect(await screen.findByText(page)).toBeInTheDocument();
    answer({ id: "key_1", token: "sd_held_secret" });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("sd_held_secret")).toBeInTheDocument();
    expect(within(dialog).getByText("HELD KEY")).toBeInTheDocument();
    expect(within(dialog).getAllByText("alpha@bots.bot").length).toBeGreaterThan(0);
  });

  it("keeps every key that comes in reverse order until the reader closes each", async () => {
    const user = userEvent.setup();
    const answers: ((r: { id: string; token: string }) => void)[] = [];
    vi.spyOn(api, "createServiceAccountKey").mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const go = renderApp();

    const field = await screen.findByPlaceholderText("Key name");
    await user.type(field, "FIRST");
    await user.click(screen.getByRole("button", { name: "New key" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    go("/app/documents");
    go("/app/settings/service-accounts");
    await user.type(await screen.findByPlaceholderText("Key name"), "SECOND");
    await user.click(screen.getByRole("button", { name: "New key" }));
    await waitFor(() => expect(answers).toHaveLength(2));
    go("/app/settings/profile");
    answers[1]({ id: "key_2", token: "sd_second" });
    answers[0]({ id: "key_1", token: "sd_first" });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("sd_second")).toBeInTheDocument();
    await user.click(await copyButtonOf("sd_second"));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await within(dialog).findByText("sd_first")).toBeInTheDocument();
  });
});

describe("the Bots list", () => {
  const bots = Array.from({ length: 13 }, (_, i) => ({
    id: `sa_${i}`,
    name: `sol-r10-1793869941${i}@hearty.review.bot`,
  }));
  beforeEach(() => {
    vi.spyOn(api, "listServiceAccounts").mockResolvedValue({
      items: bots,
    } as Awaited<ReturnType<typeof api.listServiceAccounts>>);
    vi.spyOn(api, "listServiceAccountKeys").mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the part of each address that tells bots apart, with the whole in a title", async () => {
    window.matchMedia = () =>
      ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never;
    renderPage();
    const row = await screen.findByRole("button", { name: /^sol-r10-17938699412\b/ });
    expect(row).toHaveAttribute("title", "sol-r10-17938699412@hearty.review.bot");
    expect(within(row).getByText("sol-r10-17938699412")).toHaveClass("truncate");
    expect(within(row).getByText("@hearty.review.bot")).toBeInTheDocument();
  });

  it("brings the detail of a picked bot into view on a narrow screen", async () => {
    const user = userEvent.setup();
    // A narrow screen, with motion.
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes("max-width"),
        addEventListener() {},
        removeEventListener() {},
      }) as never;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderPage();

    await screen.findByRole("button", { name: /^sol-r10-17938699410\b/ });
    // The first bot shows at once, with no jump.
    expect(scrolled).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^sol-r10-17938699412\b/ }));
    await waitFor(() =>
      expect(scrolled).toHaveBeenCalledWith({ block: "start", behavior: "smooth" }),
    );
    expect(document.activeElement).toHaveTextContent(
      "sol-r10-17938699412@hearty.review.bot",
    );
    expect(screen.getByRole("button", { name: "New key" })).toBeInTheDocument();
  });

  it("brings the detail into view on each pick, also of the bot that shows", async () => {
    const user = userEvent.setup();
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes("max-width"),
        addEventListener() {},
        removeEventListener() {},
      }) as never;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderPage();

    const first = await screen.findByRole("button", { name: /^sol-r10-17938699410\b/ });
    expect(first).toHaveAttribute("aria-current", "true");
    await user.click(first);
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    await user.click(first);
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
  });
});
