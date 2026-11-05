// A form dialog that closes before its response comes must still give the
// result to the reader, and must not close, clear, or leave a later form.
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { UploadVersionSheet } from "@/pages/doc-upload-version";
import { NewFolderDialog } from "./dialogs";
import { UploadBackupDialog } from "./upload-backup";

const HTML = new File(["<h1>hi</h1>"], "report.html", { type: "text/html" });

// held is a response that the test gives when it wants.
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function Where() {
  return <output aria-label="Path">{useLocation().pathname}</output>;
}

function renderDialog(
  dialog: (open: boolean, setOpen: (o: boolean) => void) => React.ReactNode,
) {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {dialog(open, setOpen)}
        <Where />
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
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  const input = screen
    .getByRole("dialog")
    .querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(input!, HTML);
}

describe("a form dialog that closes before its response", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("names a new folder in a toast, and keeps a later form open", async () => {
    const user = userEvent.setup();
    const answer = held<Awaited<ReturnType<typeof api.createFolder>>>();
    vi.spyOn(api, "createFolder").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    renderDialog((open, setOpen) => (
      <NewFolderDialog open={open} onOpenChange={setOpen} />
    ));

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByPlaceholderText("Folder name"), "First");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByPlaceholderText("Folder name"), "Second");

    answer.resolve({ id: "fld_1" } as Awaited<ReturnType<typeof api.createFolder>>);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Created folder “First”."),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Folder name")).toHaveValue("Second");
  });

  it("names an uploaded document in a toast, and does not open it", async () => {
    const user = userEvent.setup();
    const answer = held<Awaited<ReturnType<typeof api.createDocument>>>();
    vi.spyOn(api, "createDocument").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    renderDialog((open, setOpen) => (
      <UploadBackupDialog open={open} onOpenChange={setOpen} />
    ));

    await user.click(screen.getByRole("button", { name: "Open" }));
    await upload(user);
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Q3 plan");
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    answer.resolve({ id: "doc_1" } as Awaited<ReturnType<typeof api.createDocument>>);
    await waitFor(() => expect(success).toHaveBeenCalledWith("Uploaded “Q3 plan”."));
    expect(screen.getByLabelText("Path")).toHaveTextContent(/^\/$/);
  });

  it("keeps a later version form open with its summary", async () => {
    const user = userEvent.setup();
    const answer = held<Awaited<ReturnType<typeof api.createVersion>>>();
    vi.spyOn(api, "createVersion").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    renderDialog((open, setOpen) => (
      <UploadVersionSheet
        docId="doc_1"
        baseVersion="ver_1"
        open={open}
        onOpenChange={setOpen}
      />
    ));

    await user.click(screen.getByRole("button", { name: "Open" }));
    await upload(user);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByPlaceholderText("Change summary"), "Second try");

    answer.resolve({ id: "ver_2" } as Awaited<ReturnType<typeof api.createVersion>>);
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Change summary")).toHaveValue("Second try");
  });
});
