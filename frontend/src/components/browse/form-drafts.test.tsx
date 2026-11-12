// The words typed in a form stay until the reader sends or discards them, and
// a form never sends them for something that changed after the reader saw it.
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { clearFieldDrafts } from "@/lib/field-drafts";
import { UploadVersionSheet } from "@/pages/doc-upload-version";
import { NewFolderDialog, RenameFolderDialog } from "./dialogs";
import { UploadBackupDialog } from "./upload-backup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearFieldDrafts();
});

const html = (name: string, title: string) =>
  new File([`<title>${title}</title>`], name, { type: "text/html" });

// Host gives a dialog its open state and a value that the test changes, as
// a remote update does.
function renderDialog(
  dialog: (open: boolean, setOpen: (o: boolean) => void, value: string) => ReactNode,
  first = "",
) {
  let change!: (value: string) => void;
  function Host() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(first);
    change = setValue;
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {dialog(open, setOpen, value)}
      </>
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Host />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { change: (value: string) => change(value) };
}

async function pick(user: ReturnType<typeof userEvent.setup>, file: File) {
  const input = screen
    .getByRole("dialog")
    .querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(input!, file);
}

it("keeps a folder name through Esc, says that it came back, and lets Cancel discard it", async () => {
  const user = userEvent.setup();
  renderDialog((open, setOpen) => (
    <NewFolderDialog open={open} onOpenChange={setOpen} />
  ));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Plans");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Plans");
  expect(screen.getByText("Your folder name from earlier came back.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("");
});

it("takes the title of the file that is picked, not of a file picked before it", async () => {
  const user = userEvent.setup();
  const create = vi
    .spyOn(api, "createDocument")
    .mockResolvedValue({ id: "doc_1" } as Awaited<
      ReturnType<typeof api.createDocument>
    >);
  renderDialog((open, setOpen) => (
    <UploadBackupDialog open={open} onOpenChange={setOpen} />
  ));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await pick(user, html("a.html", "Plan A"));
  await pick(user, html("b.html", "Plan B"));
  await waitFor(() =>
    expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Plan B"),
  );
  await user.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0]).toBe("Plan B");
});

it("keeps a typed upload title through a close, and asks for the file again", async () => {
  const user = userEvent.setup();
  renderDialog((open, setOpen) => (
    <UploadBackupDialog open={open} onOpenChange={setOpen} />
  ));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.type(screen.getByLabelText("Title"), "Q3 plan");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByLabelText("Title")).toHaveValue("Q3 plan");
  expect(
    screen.getByText("Your title from earlier came back. Choose the file again."),
  ).toBeTruthy();
});

it("keeps the summary and the base of the upload when a new version comes", async () => {
  const user = userEvent.setup();
  const create = vi
    .spyOn(api, "createVersion")
    .mockResolvedValue({ id: "ver_3" } as Awaited<
      ReturnType<typeof api.createVersion>
    >);
  const { change } = renderDialog(
    (open, setOpen, live) => (
      <UploadVersionSheet
        docId="doc_1"
        base={{ version: "ver_1", seq: 3 }}
        live={{ version: live }}
        open={open}
        onOpenChange={setOpen}
      />
    ),
    "ver_1",
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.type(
    screen.getByRole("textbox", { name: "Change summary" }),
    "Fix tables",
  );
  await pick(user, html("v.html", "V"));
  change("ver_2");
  // The server moves the upload over the new version, or refuses it.
  await user.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0].slice(0, 3)).toEqual([
    "doc_1",
    { version: "ver_1", seq: 3 },
    "Fix tables",
  ]);
});

it("keeps a folder name when the folder is renamed elsewhere, and asks which to use", async () => {
  const user = userEvent.setup();
  const update = vi
    .spyOn(api, "updateFolder")
    .mockResolvedValue({} as Awaited<ReturnType<typeof api.updateFolder>>);
  const { change } = renderDialog(
    (open, setOpen, title) => (
      <RenameFolderDialog open={open} onOpenChange={setOpen} id="fld_1" title={title} />
    ),
    "Plans",
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  const field = screen.getByRole("textbox", { name: "Folder name" });
  expect(field).toHaveValue("Plans");
  await user.type(field, " 2027");
  change("Roadmap");
  expect(
    await screen.findByText("The folder was renamed elsewhere. It is now:"),
  ).toBeTruthy();
  expect(field).toHaveValue("Plans 2027");
  const rename = screen.getByRole("button", { name: "Rename" });
  expect(rename).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  await user.click(rename);
  await waitFor(() => expect(update).toHaveBeenCalledWith("fld_1", "Plans 2027"));
});
