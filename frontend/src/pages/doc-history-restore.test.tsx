import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Document, type SavedVersion, type Version } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { DocProvider, type DocContextValue } from "./doc-context";
import { RestoreButton } from "./doc-history";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), promise: vi.fn() },
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
  let answer!: (v: SavedVersion) => void;
  vi.spyOn(api, "restoreVersion").mockReturnValue(
    new Promise((resolve) => (answer = resolve)),
  );
  const doc = { docId: "doc_1", showCurrent: vi.fn() };
  const client = new QueryClient();
  // The page reads the document again after a save.
  client.setQueryDefaults(queryKeys.document("doc_1"), {
    queryFn: async () => ({ title: "Plan B" }) as Document,
  });
  client.setQueryData(queryKeys.document("doc_1"), { title: "Plan B" } as Document);
  client.setQueryData(queryKeys.versions("doc_1"), { items: [v3, v5] });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  let nav!: NavigateFunction;
  function Nav() {
    nav = useNavigate();
    return null;
  }
  // The preview is in the link, as on the document page.
  const ui = (version: Version) => (
    <QueryClientProvider client={client}>
      <DocProvider value={doc as unknown as DocContextValue}>
        <RestoreButton docId="doc_1" version={version} />
      </DocProvider>
    </QueryClientProvider>
  );
  const view = render(ui(v3), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/app/d/doc_1?version=v3"]}>
        <Nav />
        {children}
      </MemoryRouter>
    ),
  });
  const preview = (version: Version) => {
    act(() => void nav(`/app/d/doc_1?version=${version.id}`));
    view.rerender(ui(version));
  };
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  const release = (saved: SavedVersion = { id: "v6", number: 6, seq: 6 }) =>
    act(async () => answer(saved));
  return { doc, view, preview, invalidate, release };
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
  expect(doc.showCurrent).not.toHaveBeenCalled();
});

it("leaves another preview on screen, after a Restore ends", async () => {
  const { doc, preview, release } = renderHeldRestore();
  preview(v5);
  await release();

  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(doc.showCurrent).not.toHaveBeenCalled();
});

it("shows the restored document to a reader who stays on the preview", async () => {
  const { doc, release } = renderHeldRestore();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restore" })).toHaveAttribute(
      "aria-busy",
    ),
  );
  await release();

  await waitFor(() => expect(doc.showCurrent).toHaveBeenCalledOnce());
});

it("says that the document already has the content when the restore changes nothing, and shows the document", async () => {
  const { doc, release } = renderHeldRestore();
  // The entry is the document as it is: the server makes no version.
  await release({ ...v5, seq: 5, unchanged: true });

  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      "“Plan B” already has this content.",
    ),
  );
  // Nothing was restored, so there is nothing to undo.
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  await waitFor(() => expect(doc.showCurrent).toHaveBeenCalledOnce());
});
