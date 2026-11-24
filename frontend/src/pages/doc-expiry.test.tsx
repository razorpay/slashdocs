import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Document } from "@/api";
import { formatTimestamp } from "@/lib/format-date";
import { queryKeys } from "@/lib/queryKeys";
import { ExpiryDialog } from "./doc-expiry";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DAY = 24 * 3_600_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

function open(expiresAt?: string, enabled = true, owner = true, changesLeft?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ExpiryDialog
        docId="doc_1"
        expiresAt={expiresAt}
        enabled={enabled}
        owner={owner}
        changesLeft={changesLeft}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onOpenChange };
}

const save = () => screen.getByRole("button", { name: "Save" });

describe("ExpiryDialog", () => {
  it("says that a document with no expiry is kept, and keeps Save off", () => {
    open();
    expect(screen.getByRole("heading", { name: "Auto-delete" })).toBeVisible();
    expect(
      screen.getByText("This document is kept until you delete it."),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "Keep" })).toBeChecked();
    expect(save()).toBeDisabled();
    expect(
      screen.getByText(
        "Auto-delete removes the document, its history, and all comments. This cannot be undone.",
      ),
    ).toBeVisible();
  });

  it("says when the document is deleted, and checks no period", () => {
    const expiresAt = inDays(3);
    open(expiresAt);
    expect(
      screen.getByText(`This document is deleted on ${formatTimestamp(expiresAt)}.`),
    ).toBeVisible();
    expect(screen.queryAllByRole("radio", { checked: true })).toHaveLength(0);
    expect(save()).toBeDisabled();
  });

  it("sets the expiry to the picked period, and closes", async () => {
    const user = userEvent.setup();
    const set = vi
      .spyOn(api, "setDocumentExpiry")
      .mockResolvedValue({ id: "doc_1", expires_at: inDays(7) } as Document);
    const { invalidate, onOpenChange } = open();

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(save()).toBeEnabled();
    await user.click(save());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(set).toHaveBeenCalledWith("doc_1", "7d");
    const keys = invalidate.mock.calls.map(([filter]) => filter?.queryKey);
    expect(keys).toContainEqual(queryKeys.document("doc_1"));
    expect(keys).toContainEqual(queryKeys.documents());
    expect(keys).toContainEqual(queryKeys.foldersAll());
    expect(toast.success).toHaveBeenCalledWith("This document is deleted in 7 days.");
  });

  it("says 24 hours of a period of 1 day that was just set", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "setDocumentExpiry").mockResolvedValue({
      id: "doc_1",
      expires_at: inDays(1),
    } as Document);
    open();
    await user.click(screen.getByRole("radio", { name: "1 day" }));
    await user.click(save());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "This document is deleted in 24 hours.",
      ),
    );
  });

  it("removes the expiry when Keep is picked over one", async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(api, "setDocumentExpiry").mockResolvedValue({
      id: "doc_1",
    } as Document);
    const { onOpenChange } = open(inDays(3));

    await user.click(screen.getByRole("radio", { name: "Keep" }));
    expect(save()).toBeEnabled();
    await user.click(save());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(set).toHaveBeenCalledWith("doc_1", null);
    expect(toast.success).toHaveBeenCalledWith("This document is kept.");
  });

  it("lets Save go again when the picked period is the one that it has", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "setDocumentExpiry").mockResolvedValue({} as Document);
    open(inDays(7));
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(save()).toBeEnabled();
  });

  it("keeps the dialog open and says why when the change fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "setDocumentExpiry").mockRejectedValue(
      new Error("The server did not set the expiry."),
    );
    const { onOpenChange } = open();

    await user.click(screen.getByRole("radio", { name: "1 day" }));
    await user.click(save());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The server did not set the expiry."),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("falls back to its own words when the error has none", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "setDocumentExpiry").mockRejectedValue("no");
    open();
    await user.click(screen.getByRole("radio", { name: "1 day" }));
    await user.click(save());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not change auto-delete."),
    );
  });

  it("closes with Cancel and changes nothing", async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(api, "setDocumentExpiry");
    const { onOpenChange } = open();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(set).not.toHaveBeenCalled();
  });

  describe("with the feature off on the server", () => {
    it("has no picker, says what will happen, and offers to keep the document", () => {
      const expiresAt = inDays(3);
      open(expiresAt, false);
      expect(screen.getByRole("heading", { name: "Auto-delete" })).toBeVisible();
      expect(
        screen.getByText(`This document is deleted on ${formatTimestamp(expiresAt)}.`),
      ).toBeVisible();
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(screen.queryByRole("radio")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(
        screen.getByText(
          "Auto-delete is turned off on this server, so no document is deleted now. When it is turned on again, the server deletes this document, with its history and all comments. Keep the document to stop that.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    });

    it("removes the expiry with Keep document, and closes", async () => {
      const user = userEvent.setup();
      const set = vi.spyOn(api, "setDocumentExpiry").mockResolvedValue({
        id: "doc_1",
      } as Document);
      const { invalidate, onOpenChange } = open(inDays(3), false);

      await user.click(screen.getByRole("button", { name: "Keep document" }));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(set).toHaveBeenCalledWith("doc_1", null);
      expect(toast.success).toHaveBeenCalledWith("This document is kept.");
      const keys = invalidate.mock.calls.map(([filter]) => filter?.queryKey);
      expect(keys).toContainEqual(queryKeys.document("doc_1"));
      expect(keys).toContainEqual(queryKeys.documents());
      expect(keys).toContainEqual(queryKeys.foldersAll());
    });

    it("says why when Keep document fails, and stays open", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "setDocumentExpiry").mockRejectedValue(new Error("Not allowed."));
      const { onOpenChange } = open(inDays(3), false);
      await user.click(screen.getByRole("button", { name: "Keep document" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed."));
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("closes with Cancel and changes nothing", async () => {
      const user = userEvent.setup();
      const set = vi.spyOn(api, "setDocumentExpiry");
      const { onOpenChange } = open(inDays(3), false);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(set).not.toHaveBeenCalled();
    });
  });

  it("gives an editor the later periods and not Keep, and saves a later one", async () => {
    const user = userEvent.setup();
    const set = vi
      .spyOn(api, "setDocumentExpiry")
      .mockResolvedValue({ id: "doc_1", expires_at: inDays(30) } as Document);
    open(inDays(3), true, false);
    expect(screen.getByText(/Only the owner can make it sooner/)).toBeVisible();
    expect(screen.getByRole("radio", { name: "1 day" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "3 days" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Keep" })).toBeDisabled();
    expect(screen.getByText(/Only the owner can make it sooner or keep/)).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "1 month" }));
    await user.click(save());
    await waitFor(() => expect(set).toHaveBeenCalledWith("doc_1", "30d"));
  });

  it("moves the keys of an editor past the periods that are sooner", async () => {
    const user = userEvent.setup();
    open(inDays(3), true, false);
    // The tab stop is the first period that an editor can pick.
    expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    screen.getByRole("radio", { name: "1 month" }).focus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "3 months" })).toBeChecked();
  });

  it("gives the owner every period", () => {
    open(inDays(3));
    for (const name of ["Keep", "1 day", "3 days", "7 days", "1 month", "3 months"])
      expect(screen.getByRole("radio", { name })).toBeEnabled();
  });

  it("tells an editor how many changes the editors have left", () => {
    open(inDays(3), true, false, 2);
    expect(screen.getByText(/Editors can change this 2 more times/)).toBeVisible();
    expect(screen.getByRole("radio", { name: "7 days" })).toBeEnabled();
  });

  it("offers an editor nothing when the editors used their changes", () => {
    open(inDays(3), true, false, 0);
    expect(screen.getByText(/Ask the owner to change it/)).toBeVisible();
    for (const name of ["Keep", "1 day", "7 days", "3 months"])
      expect(screen.getByRole("radio", { name })).toBeDisabled();
    expect(save()).toBeDisabled();
  });

  it("does not count for the owner", () => {
    open(inDays(3), true, true, 0);
    expect(screen.queryByText(/Editors/)).toBeNull();
    expect(screen.getByRole("radio", { name: "1 day" })).toBeEnabled();
  });
});
