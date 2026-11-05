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
import { api, type Version } from "@/api";
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
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>
      <DocProvider value={doc as unknown as DocContextValue}>{children}</DocProvider>
    </MemoryRouter>
  );
  const view = renderHook(() => ({ show: useShowSaved(), nav: useNavigate() }), {
    wrapper,
  });
  return { doc, view };
}

const saved = { id: "v6" } as Version;

it("goes to a saved version when the reader still sees what they saw at the start", () => {
  const { doc, view } = renderShowSaved("/app/d/doc_1");
  const show = view.result.current.show();
  show(saved);
  expect(doc.showLatest).toHaveBeenCalled();
  expect(doc.stayOnVersion).toHaveBeenCalledWith("v6");
});

it("leaves the reader on a version that they opened while the save went", () => {
  const { doc, view } = renderShowSaved("/app/d/doc_1");
  const show = view.result.current.show();
  act(() => void view.result.current.nav("/app/d/doc_1?version=v1"));
  show(saved);
  expect(doc.showLatest).not.toHaveBeenCalled();
  expect(doc.stayOnVersion).not.toHaveBeenCalled();
});

it("refreshes but stays on a version that the reader opened while an upload went", async () => {
  let answer!: (v: Version) => void;
  vi.spyOn(api, "createVersion").mockReturnValue(new Promise((r) => (answer = r)));
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  let nav!: NavigateFunction;
  function Sheet({ open }: { open: boolean }) {
    nav = useNavigate();
    return (
      <UploadVersionSheet
        docId="doc_1"
        baseVersion="v5"
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
  await act(async () => answer({ id: "v6" } as Version));

  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.versions("doc_1") }),
  );
  expect(doc.showLatest).not.toHaveBeenCalled();
  expect(doc.stayOnVersion).not.toHaveBeenCalled();
});
