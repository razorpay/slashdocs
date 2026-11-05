import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Document, type Version } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { DocProvider, type DocContextValue } from "./doc-context";
import { RestoreButton } from "./doc-history";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const v3 = { id: "v3", number: 3 } as Version;
const v5 = { id: "v5", number: 5 } as Version;

// A Restore whose answer waits until the test releases it.
function renderHeldRestore() {
  let answer!: (v: Version) => void;
  vi.spyOn(api, "restoreVersion").mockReturnValue(
    new Promise((resolve) => (answer = resolve)),
  );
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  const client = new QueryClient();
  client.setQueryData(queryKeys.document("doc_1"), { title: "Plan B" } as Document);
  client.setQueryData(queryKeys.versions("doc_1"), { items: [v3, v5] });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const ui = (version: Version) => (
    <QueryClientProvider client={client}>
      <DocProvider value={doc as unknown as DocContextValue}>
        <RestoreButton docId="doc_1" version={version} />
      </DocProvider>
    </QueryClientProvider>
  );
  const view = render(ui(v3));
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  const release = () => act(async () => answer({ id: "v6", number: 6 } as Version));
  return { doc, view, ui, invalidate, release };
}

it("refreshes the document but stays where the reader went, after a Restore ends", async () => {
  const { doc, view, invalidate, release } = renderHeldRestore();
  // The reader leaves the document, for Documents or another document.
  view.unmount();
  await release();

  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Restored an earlier version of “Plan B”.",
      expect.anything(),
    ),
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.versions("doc_1") });
  expect(doc.showLatest).not.toHaveBeenCalled();
  expect(doc.stayOnVersion).not.toHaveBeenCalled();
});

it("leaves another preview on screen, after a Restore ends", async () => {
  const { doc, view, ui, release } = renderHeldRestore();
  view.rerender(ui(v5));
  await release();

  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(doc.showLatest).not.toHaveBeenCalled();
});

it("shows the restored document to a reader who stays on the preview", async () => {
  const { doc, release } = renderHeldRestore();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore" })).toHaveAttribute(
      "aria-busy",
    ),
  );
  await release();

  await waitFor(() => expect(doc.stayOnVersion).toHaveBeenCalledWith("v6"));
  expect(doc.showLatest).toHaveBeenCalled();
});
