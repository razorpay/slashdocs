import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type FolderEntry } from "@/api";
import { MoveDialog } from "./move-dialog";

const folder = (id: string, title: string): FolderEntry => ({
  type: "folder",
  folder: { id, title },
});

function renderMove(props: {
  type: "document" | "folder";
  id: string;
  parentId?: string;
}) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MoveDialog open onOpenChange={onOpenChange} title="Q3 plan" {...props} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("MoveDialog", () => {
  afterEach(cleanup);

  it("moves a document into a folder with the keyboard", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listFolders").mockResolvedValue({
      items: [folder("fld_a", "Reports"), folder("fld_b", "Plans")],
      has_more: false,
    });
    const move = vi
      .spyOn(api, "moveDocumentToFolder")
      .mockResolvedValue({ document_id: "doc_1", moved: true });
    const { onOpenChange } = renderMove({ type: "document", id: "doc_1" });

    const list = screen.getByRole("list", { name: "Folders" });
    // The document is at the top level, so that is the current place.
    expect(
      await within(list).findByRole("button", { name: /Documents/ }),
    ).toBeDisabled();
    await user.tab();
    await user.tab();
    expect(within(list).getByRole("button", { name: "Plans" })).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(move).toHaveBeenCalledWith("fld_b", "doc_1"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("searches the folders the reader can edit and moves a folder to the top level", async () => {
    const user = userEvent.setup();
    const inside: FolderEntry = {
      type: "folder",
      folder: {
        id: "fld_in",
        title: "Deep inside",
        ancestors: [{ id: "fld_1", title: "Q3 plan" }],
      },
    };
    const list = vi.spyOn(api, "listFolders").mockImplementation(async (_, __, q) => ({
      items: q
        ? [folder("fld_deep", "Deep reports"), inside]
        : [folder("fld_parent", "Team")],
      has_more: false,
    }));
    const update = vi
      .spyOn(api, "updateFolder")
      .mockResolvedValue({ id: "fld_1", title: "Q3 plan" });
    renderMove({ type: "folder", id: "fld_1", parentId: "fld_parent" });

    expect(await screen.findByRole("button", { name: /Team/ })).toBeDisabled();
    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "deep");
    expect(await screen.findByRole("button", { name: "Deep reports" })).toBeEnabled();
    expect(list).toHaveBeenLastCalledWith(undefined, undefined, "deep", "editor");
    // A folder cannot move into a folder in it.
    expect(screen.queryByRole("button", { name: /Deep inside/ })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search folders" }));
    await user.click(await screen.findByRole("button", { name: "Documents" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("fld_1", undefined, null));
  });

  it("names the path of folders with the same title", async () => {
    vi.spyOn(api, "listFolders").mockResolvedValue({
      items: [
        {
          type: "folder",
          folder: {
            id: "fld_n",
            title: "Reports",
            ancestors: [{ id: "n", title: "North" }],
          },
        },
        {
          type: "folder",
          folder: {
            id: "fld_s",
            title: "Reports",
            ancestors: [{ id: "s", title: "South" }],
          },
        },
      ],
      has_more: false,
    });
    renderMove({ type: "document", id: "doc_1" });
    expect(
      await screen.findByRole("button", { name: "Reports, in North" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reports, in South" })).toBeEnabled();
  });

  it("says that a search finds more folders than the list shows", async () => {
    vi.spyOn(api, "listFolders").mockResolvedValue({
      items: [folder("fld_a", "Reports")],
      has_more: true,
    });
    renderMove({ type: "document", id: "doc_1" });
    expect(await screen.findByText("Search to find more folders.")).toBeVisible();
  });

  it("offers Retry when the folders do not load", async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(api, "listFolders")
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue({ items: [folder("fld_a", "Reports")], has_more: false });
    renderMove({ type: "document", id: "doc_1" });
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Reports" })).toBeEnabled();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
