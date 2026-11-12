import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, type SavedVersion } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearFieldDrafts } from "@/lib/field-drafts";
import { queryKeys } from "@/lib/queryKeys";
import { DocProvider, type DocContextValue } from "./doc-context";
import { UploadVersionSheet } from "./doc-upload-version";
import { useShowSaved } from "./use-show-saved";

afterEach(() => {
  cleanup();
  clearFieldDrafts();
  vi.restoreAllMocks();
});

function renderShowSaved(entry: string) {
  const doc = { docId: "doc_1", showCurrent: vi.fn() };
  const client = new QueryClient();
  // The answer of the server after the save.
  const read = vi.fn(async () => ({ id: "doc_1", current_version_id: "v6" }));
  void client.prefetchQuery({ queryKey: queryKeys.document("doc_1"), queryFn: read });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <DocProvider value={doc as unknown as DocContextValue}>{children}</DocProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = renderHook(() => ({ show: useShowSaved(), nav: useNavigate() }), {
    wrapper,
  });
  return { doc, view, read };
}

it("reads the document again, then shows it, when the reader still sees what they saw at the start", async () => {
  const { doc, view, read } = renderShowSaved("/app/d/doc_1");
  const show = view.result.current.show();
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  await show();
  // The frame loads the version that the page knows.
  expect(read).toHaveBeenCalledTimes(2);
  expect(doc.showCurrent).toHaveBeenCalledOnce();
});

it("leaves the reader on a version that they opened while the save went", async () => {
  const { doc, view } = renderShowSaved("/app/d/doc_1");
  const show = view.result.current.show();
  act(() => void view.result.current.nav("/app/d/doc_1?version=v1"));
  await show();
  expect(doc.showCurrent).not.toHaveBeenCalled();
});

it("refreshes but stays on a version that the reader opened while an upload went", async () => {
  let answer!: (v: SavedVersion) => void;
  vi.spyOn(api, "createVersion").mockReturnValue(new Promise((r) => (answer = r)));
  const doc = { docId: "doc_1", showCurrent: vi.fn() };
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  let nav!: NavigateFunction;
  function Sheet({ open }: { open: boolean }) {
    nav = useNavigate();
    return (
      <UploadVersionSheet
        docId="doc_1"
        base={{ version: "v5" }}
        live={{ version: "v5" }}
        showSaved={useShowSaved()}
        open={open}
        onOpenChange={() => {}}
      />
    );
  }
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/app/d/doc_1"]}>
          <DocProvider value={doc as unknown as DocContextValue}>
            <Sheet open={open} />
          </DocProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(ui(true));
  const file = new File(["<p>new</p>"], "new.html", { type: "text/html" });
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(api.createVersion).toHaveBeenCalled());
  view.rerender(ui(false));
  act(() => void nav("/app/d/doc_1?version=v1"));
  await act(async () => answer({ id: "v6", number: 6, seq: 6 }));

  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.versions("doc_1") }),
  );
  expect(doc.showCurrent).not.toHaveBeenCalled();
});
