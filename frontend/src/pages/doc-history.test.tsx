import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal, Version } from "@/api";
import { HistoryDialog } from "./doc-history";

const ana: Principal = { type: "user", id: "ana", name: "Ana" };
const versions: Version[] = [1, 2, 3].map((number) => ({
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
  latest = "ver_3",
  onSelectVersion = () => {},
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
        onSelectVersion={onSelectVersion}
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
    const dialog = renderHistory("ver_3");
    expect(await within(dialog).findByText("Current")).toBeVisible();
    expect(within(dialog).queryByText("Viewing")).toBeNull();
  });

  it("marks the entry that the preview shows", async () => {
    const dialog = renderHistory("ver_2");
    expect(
      await within(dialog).findByText("Viewing", { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows every entry, also those that are newer than a restored one", async () => {
    // The author typed x, restored the version before it, and typed y.
    const restored: Version[] = [
      versions[0],
      { ...versions[1], sha256: "b", change_summary: "Added “x”" },
      { ...versions[2], sha256: "a", change_summary: "Restored an earlier version" },
      {
        id: "ver_4",
        number: 4,
        created_by: ana,
        sha256: "c",
        change_summary: "Added “y”",
      },
    ];
    const onSelectVersion = vi.fn();
    const dialog = renderHistory(
      "ver_4",
      vi.fn(async () => json({ items: restored })),
      "ver_4",
      onSelectVersion,
    );
    const newest = (await within(dialog).findByText("Added “y”")).closest("button")!;
    expect(within(newest).getByText("Current")).toBeVisible();
    fireEvent.click(within(dialog).getByText("Added “x”"));
    expect(onSelectVersion).toHaveBeenCalledExactlyOnceWith("ver_2");
    // The version on screen opens nothing.
    fireEvent.click(newest);
    expect(onSelectVersion).toHaveBeenCalledOnce();
  });

  it("gives each version a row of its own: the time, the person, and what changed", async () => {
    // An agent pushed thirteen times in two minutes.
    const bot: Principal = { type: "service_account", id: "sa_docs" };
    const pushes: Version[] = Array.from({ length: 13 }, (_, i) => ({
      id: `ver_${i + 2}`,
      number: i + 2,
      created_by: bot,
      created_at: new Date(Date.UTC(2026, 9, 1, 10, 0, i * 10)).toISOString(),
      change_summary: `Added “push ${i + 1}”`,
    }));
    const dialog = renderHistory(
      "ver_14",
      vi.fn(async () => json({ items: [versions[0], ...pushes] })),
      "ver_14",
    );
    const newest = (await within(dialog).findByText("Added “push 13”")).closest(
      "button",
    )!;
    const rows = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.querySelector("time"));
    // The newest is first, and nothing hides behind a count.
    expect(rows).toHaveLength(14);
    expect(rows[0]).toBe(newest);
    expect(newest.querySelector("time")).toHaveAttribute(
      "datetime",
      pushes[12].created_at,
    );
    expect(newest).toHaveTextContent(/sa_docsAdded “push 13”$/);
    expect(rows[13]).toHaveTextContent(/AnaCreated$/);
    expect(dialog).not.toHaveTextContent(/earlier|since/);
  });

  it("names everyone who typed in a version, at the time of its last edit", async () => {
    const ravi: Principal = { type: "user", id: "ravi", name: "Ravi" };
    const edited_at = new Date(Date.UTC(2026, 9, 1, 11)).toISOString();
    const typed: Version[] = [
      versions[0],
      { ...versions[1], created_by: ravi },
      {
        ...versions[2],
        created_by: ravi,
        authors: [ravi, ana],
        edited_at,
        change_summary: "Added “x”",
      },
    ];
    const dialog = renderHistory(
      "ver_3",
      vi.fn(async () => json({ items: typed })),
    );
    const entry = (await within(dialog).findByText("Ravi and Ana")).closest("button")!;
    // The version that people still type in is a row as each other one.
    expect(entry).toHaveTextContent(/CurrentRavi and AnaAdded “x”$/);
    expect(entry.querySelector("time")).toHaveAttribute("datetime", edited_at);
    expect(dialog).not.toHaveTextContent("Now");
  });

  it("reads the versions again each time it opens", async () => {
    const fetch = vi.fn(async () => json({ items: versions }));
    vi.stubGlobal("fetch", fetch);
    const history = (open: boolean) => (
      <HistoryDialog
        open={open}
        onOpenChange={() => {}}
        docId="doc_1"
        current="ver_3"
        latest="ver_3"
        canRestore
        onSelectVersion={() => {}}
      />
    );
    const client = new QueryClient();
    const { rerender } = render(history(false), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    rerender(history(true));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("says what an entry is for, and that it can come back only to a reader who can restore", async () => {
    const dialog = renderHistory("ver_3");
    expect(
      within(dialog).getByText(
        "Open an entry to see the document as it was, and restore it to bring it back.",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/Every edit is kept/)).toBeNull();
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
