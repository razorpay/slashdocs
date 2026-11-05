import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Document } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentsPage } from "./documents";

const plan: Document = { id: "doc_plan", title: "Q3 plan" };

function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

// A stand-in for the document page, with the Back of the browser.
function DocumentStub() {
  const nav = useNavigate();
  return <button onClick={() => nav(-1)}>Back</button>;
}

function renderDocuments(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              path="/app/documents"
              element={
                <>
                  <DocumentsPage />
                  <Search />
                </>
              }
            />
            <Route path="/app/d/:id" element={<DocumentStub />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("DocumentsPage search", () => {
  beforeEach(() => {
    // jsdom has no media queries.
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList;
    vi.spyOn(api, "me").mockResolvedValue({} as Awaited<ReturnType<typeof api.me>>);
    vi.spyOn(api, "listPins").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listFeatured").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listFolders").mockResolvedValue({ items: [], has_more: false });
    vi.spyOn(api, "listDocuments").mockImplementation(async (q) => ({
      items: q ? [{ ...plan, snippet: "the \u0002plan\u0003" }] : [plan],
      has_more: false,
    }));
  });
  afterEach(cleanup);

  it("keeps the query in the URL, so Back from a result shows the results", async () => {
    const user = userEvent.setup();
    renderDocuments("/app/documents");
    const input = await screen.findByRole("combobox", { name: "Search documents" });
    await user.type(input, "plan");
    await waitFor(() =>
      expect(screen.getByTestId("search")).toHaveTextContent("?q=plan"),
    );
    await waitFor(() => expect(api.listDocuments).toHaveBeenLastCalledWith("plan", 0));

    await user.click(await screen.findByRole("link", { name: /Q3 plan/ }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(
      await screen.findByRole("combobox", { name: "Search documents" }),
    ).toHaveValue("plan");
    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
  });

  it("keeps every letter of fast typing", async () => {
    const user = userEvent.setup({ delay: null });
    renderDocuments("/app/documents");
    const input = await screen.findByRole("combobox", { name: "Search documents" });
    await user.type(input, "abcdefghij");
    expect(input).toHaveValue("abcdefghij");
    await waitFor(() =>
      expect(screen.getByTestId("search")).toHaveTextContent("?q=abcdefghij"),
    );
    expect(input).toHaveValue("abcdefghij");
  });

  it("says when the folders do not load, beside the documents", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listFolders)
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue({
        items: [{ type: "folder", folder: { id: "fld_1", title: "Reports" } }],
        has_more: false,
      });
    renderDocuments("/app/documents");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load folders",
    );
    expect(screen.getByRole("link", { name: /Q3 plan/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: /Reports/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the pins do not load, and loads them on Retry", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listPins).mockRejectedValue(new Error("503"));
    renderDocuments("/app/documents");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load your pins",
    );

    vi.mocked(api.listPins).mockResolvedValue({ items: [] });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
