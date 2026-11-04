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
  latest = "ver_2",
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
        latest={latest}
        canRestore
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

  it("leaves out an edit that its author undid", async () => {
    const undone: Version[] = [
      { ...versions[0], sha256: "a" },
      { ...versions[1], sha256: "b", change_summary: "Added “x”" },
      {
        id: "ver_3",
        number: 3,
        created_by: ana,
        sha256: "a",
        change_summary: "Removed “x”",
      },
      {
        id: "ver_4",
        number: 4,
        created_by: ana,
        sha256: "c",
        change_summary: "Added “y”",
      },
    ];
    const dialog = renderHistory(
      "ver_4",
      vi.fn(async () => json({ items: undone })),
      "ver_4",
    );
    expect(await within(dialog).findByText("Added “y”")).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show 1 earlier edit" }),
    );
    expect(within(dialog).getByText("Created")).toBeInTheDocument();
    expect(within(dialog).queryByText("Added “x”")).toBeNull();
    expect(within(dialog).queryByText("Removed “x”")).toBeNull();
  });

  it("gives each earlier edit its own time, small and muted", async () => {
    const dialog = renderHistory("ver_2");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Show 1 earlier edit" }),
    );
    const entry = within(dialog).getByText("Created").closest("button")!;
    const time = entry.querySelector(`time[datetime="${versions[0].created_at}"]`);
    expect(time?.parentElement).toHaveClass("text-xs", "text-[var(--color-fg-muted)]");
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
