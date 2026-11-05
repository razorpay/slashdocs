import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FolderPage } from "./folder";

const reports = { id: "fld_reports", title: "Reports" };
const plan = { id: "doc_plan", title: "Q3 plan" };

function renderFolder() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/app/folders/fld_reports"]}>
          <Routes>
            <Route path="/app/folders/:id" element={<FolderPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

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
  vi.spyOn(api, "getFolder").mockResolvedValue(reports);
  vi.spyOn(api, "listFolders").mockResolvedValue({
    items: [{ type: "document", document: plan }],
    has_more: false,
  });
});
afterEach(cleanup);

const unavailable = new APIError(503, "unavailable", "unavailable");

it("keeps the folder when only its contents fail, and does not call it empty", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listFolders).mockRejectedValueOnce(unavailable);
  renderFolder();
  expect(
    await screen.findByText("Could not load what is in this folder"),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Reports" })).toBeVisible();
  expect(screen.getByText("Check your connection, then try again.")).toBeVisible();
  expect(screen.queryByText("Empty folder")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /Q3 plan/ })).toBeVisible();
});

it.each([
  ["a 503", unavailable],
  ["a lost network", new TypeError("Failed to fetch")],
])("says that the folder did not load with %s, with Retry", async (_, error) => {
  const user = userEvent.setup();
  vi.mocked(api.getFolder).mockRejectedValueOnce(error);
  renderFolder();
  expect(await screen.findByText("Could not load folder")).toBeVisible();
  expect(screen.getByText("Check your connection, then try again.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Reports" })).toBeVisible();
});

it("tells a missing folder and a denied one apart", async () => {
  vi.mocked(api.getFolder).mockRejectedValueOnce(new APIError(404, "not_found", "x"));
  renderFolder();
  expect(await screen.findByText("Folder not found")).toBeVisible();
  cleanup();
  vi.mocked(api.getFolder).mockRejectedValueOnce(new APIError(403, "forbidden", "x"));
  renderFolder();
  expect(await screen.findByText("You don't have access to this folder")).toBeVisible();
});
