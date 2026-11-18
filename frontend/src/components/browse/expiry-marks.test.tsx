import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type FolderEntry, type ServerConfig } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnifiedGrid } from "./unified-grid";
import { UnifiedTable } from "./unified-table";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DAY = 24 * 3_600_000;
const entries: FolderEntry[] = [
  {
    type: "document",
    document: {
      id: "doc_1",
      title: "Scratch",
      expires_at: new Date(Date.now() + 3 * DAY + 60_000).toISOString(),
    },
  },
  { type: "document", document: { id: "doc_2", title: "Kept" } },
];

function renderList(
  view: "table" | "grid",
  config: Partial<ServerConfig> = { document_expiry_enabled: true },
) {
  const getConfig = vi
    .spyOn(api, "getConfig")
    .mockResolvedValue(config as ServerConfig);
  vi.spyOn(api, "me").mockResolvedValue({} as Awaited<ReturnType<typeof api.me>>);
  vi.spyOn(api, "listPins").mockResolvedValue({ items: [] } as never);
  vi.spyOn(api, "managedAccessRequests").mockResolvedValue({ items: [] } as never);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <MemoryRouter>
          {view === "table" ? (
            <UnifiedTable entries={entries} />
          ) : (
            <UnifiedGrid entries={entries} />
          )}
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return getConfig;
}

describe.each(["table", "grid"] as const)("a document in the %s", (view) => {
  it.each([
    ["on", { document_expiry_enabled: true }],
    ["off", { document_expiry_enabled: false }],
    ["not named", {}],
  ])(
    "shows the short mark of a document that expires, and no other, with the feature %s",
    async (_, config) => {
      renderList(view, config);
      const mark = await screen.findByRole("img", { name: /Deletes in 3 days/ });
      expect(mark).toHaveTextContent("3 days");
      expect(screen.getAllByRole("img", { name: /Deletes/ })).toHaveLength(1);
    },
  );

  it("asks the server for no config for the mark", async () => {
    const getConfig = renderList(view);
    await screen.findByRole("img", { name: /Deletes in 3 days/ });
    expect(getConfig).not.toHaveBeenCalled();
  });
});
