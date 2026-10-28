// Dialogs launched from a dropdown menu must outlive the menu.
//
// Radix closes an open menu whenever the window loses focus. The OS file
// picker, a Cmd-Tab, or a click into another window all do that. A dialog
// rendered inside the menu item unmounts with the menu, which is how "choose a
// file and the upload dialog vanishes" shipped in every release from v0.1.0
// (react-menu 2.1.18 and later close on window blur). These tests open each
// menu-launched dialog the way a user does, blur the window, and then finish
// the flow.
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { UploadVersionMenuItem, UploadVersionSheet } from "@/pages/doc-upload-version";
import { UploadBackupDialog, UploadBackupMenuItem } from "./upload-backup";

const HTML = new File(["<h1>hi</h1>"], "report.html", { type: "text/html" });

function Menu({
  item,
  dialog,
}: {
  item: (open: () => void) => React.ReactNode;
  dialog: (open: boolean, setOpen: (o: boolean) => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Dropdown>
        <DropdownTrigger asChild>
          <button type="button">More</button>
        </DropdownTrigger>
        <DropdownContent>{item(() => setOpen(true))}</DropdownContent>
      </Dropdown>
      {dialog(open, setOpen)}
    </>
  );
}

function renderMenu(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// Open the menu and pick its only item with the keyboard, then blur the window
// the way the OS file picker does. Returns the dialog, which must still exist.
async function openFromMenuAndBlurWindow(
  user: ReturnType<typeof userEvent.setup>,
  dialogName: string,
  role: "dialog" | "alertdialog" = "dialog",
) {
  screen.getByRole("button", { name: "More" }).focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole(role, { name: dialogName });
  // The menu has closed. If it were still open underneath, the blur below
  // would close it and take anything rendered inside it along.
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(screen.getByRole(role, { name: dialogName })).toBe(dialog);
  return dialog;
}

async function chooseFile(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  await user.upload(input!, HTML);
  // The chosen file is shown by name, not as the browser's "No file chosen".
  expect(dialog).toHaveTextContent("report.html");
}

describe("dialogs launched from a dropdown menu", () => {
  afterEach(cleanup);

  it("uploads a backup document after the window lost focus", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createDocument")
      .mockResolvedValue({ id: "doc_1" } as Awaited<
        ReturnType<typeof api.createDocument>
      >);
    renderMenu(
      <Menu
        item={(open) => <UploadBackupMenuItem onSelect={open} />}
        dialog={(open, setOpen) => (
          <UploadBackupDialog open={open} onOpenChange={setOpen} />
        )}
      />,
    );

    const dialog = await openFromMenuAndBlurWindow(user, "Upload HTML (backup)");
    const upload = screen.getByRole("button", { name: "Upload" });
    expect(upload).toBeDisabled();
    await chooseFile(user, dialog);
    expect(upload).toBeEnabled();
    await user.click(upload);

    await waitFor(() => expect(create).toHaveBeenCalledWith("report.html", HTML));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uploads a new version after the window lost focus", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createVersion")
      .mockResolvedValue({ id: "ver_2" } as Awaited<
        ReturnType<typeof api.createVersion>
      >);
    renderMenu(
      <Menu
        item={(open) => <UploadVersionMenuItem onSelect={open} />}
        dialog={(open, setOpen) => (
          <UploadVersionSheet
            docId="doc_1"
            baseVersion="ver_1"
            open={open}
            onOpenChange={setOpen}
          />
        )}
      />,
    );

    const dialog = await openFromMenuAndBlurWindow(user, "Upload new version");
    await user.type(screen.getByPlaceholderText("Change summary"), "Fix typo");
    await chooseFile(user, dialog);
    await user.click(screen.getByRole("button", { name: "Upload version" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("doc_1", "ver_1", "Fix typo", HTML, false),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the delete confirmation open after the window lost focus", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    renderMenu(
      <Menu
        item={(open) => <DropdownItem onSelect={open}>Delete document</DropdownItem>}
        dialog={(open, setOpen) => (
          <DeleteDocumentDialog
            title="Q3 plan"
            open={open}
            onOpenChange={setOpen}
            onConfirm={confirm}
          />
        )}
      />,
    );

    await openFromMenuAndBlurWindow(user, "Delete “Q3 plan”?", "alertdialog");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
