import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Version } from "@/api";
import { DocProvider, type DocContextValue } from "./doc-context";
import { PreviewBanner } from "./doc-preview-banner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const earlier = { id: "v3", number: 3, created_at: "2026-09-01T10:00:00Z" } as Version;

function renderBanner(props: { version?: Version; canRestore: boolean }) {
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={doc as unknown as DocContextValue}>
        <PreviewBanner docId="doc_1" {...props} />
      </DocProvider>
    </QueryClientProvider>,
  );
  return doc;
}

it("says when the previewed entry is from and goes back to the current document", () => {
  const doc = renderBanner({ version: earlier, canRestore: false });
  expect(screen.getByRole("status")).toHaveTextContent(
    "This is the document as it was",
  );
  expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to the current document" }));
  expect(doc.showLatest).toHaveBeenCalledOnce();
});

it("restores the previewed entry and shows the restored document", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "v9", number: 9 }), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  const doc = renderBanner({ version: earlier, canRestore: true });
  fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
  await waitFor(() => expect(doc.stayOnVersion).toHaveBeenCalledWith("v9"));
  expect(doc.showLatest).toHaveBeenCalled();
});

it("still warns before the history loads", () => {
  renderBanner({ canRestore: true });
  expect(screen.getByRole("status")).toHaveTextContent(
    "This is an earlier version of the document.",
  );
});
