import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal, Version } from "@/api";
import { HistoryDialog } from "./doc-history";

const ana: Principal = { type: "user", id: "ana", name: "Ana" };
const versions: Version[] = [1, 2].map((number) => ({
  id: `ver_${number}`,
  number,
  created_by: ana,
  created_at: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function renderHistory(
  current: string,
  fetch = vi.fn(async () => json({ items: versions })),
) {
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <HistoryDialog
        open
        onOpenChange={() => {}}
        docId="doc_1"
        current={current}
        latest="ver_2"
        onSelectVersion={() => {}}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HistoryDialog", () => {
  it("marks only the current entry when the document is not a preview", async () => {
    const dialog = renderHistory("ver_2");
    expect(await within(dialog).findByText("Current")).toBeVisible();
    expect(within(dialog).queryByText("Viewing")).toBeNull();
    // The session counts its earlier entries once, on the expander.
    expect(within(dialog).queryByText(/edits since/)).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Show 1 earlier edit" }),
    ).toBeVisible();
  });

  it("marks the entry that the preview shows", async () => {
    const dialog = renderHistory("ver_1");
    expect(
      await within(dialog).findByText("Viewing", { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows that the history loads", () => {
    const dialog = renderHistory(
      "ver_2",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    expect(within(dialog).getByLabelText("Loading the history")).toBeInTheDocument();
  });

  it("says when the history did not load, and tries again", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "Service unavailable" }, 503))
      .mockResolvedValueOnce(json({ items: versions }));
    const dialog = renderHistory("ver_2", fetch);
    expect(await within(dialog).findByText("Could not load the history")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("Current")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
