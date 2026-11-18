import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ServerConfig } from "@/api";
import { clearFieldDrafts } from "@/lib/field-drafts";
import { UploadBackupDialog } from "./upload-backup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearFieldDrafts();
});

function open(config: Partial<ServerConfig>) {
  vi.spyOn(api, "getConfig").mockResolvedValue(config as ServerConfig);
  const create = vi.spyOn(api, "createDocument").mockResolvedValue({
    id: "doc_1",
  } as Awaited<ReturnType<typeof api.createDocument>>);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <UploadBackupDialog open onOpenChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return create;
}

const file = new File(["<title>Plan</title>"], "plan.html", { type: "text/html" });
async function upload(user: ReturnType<typeof userEvent.setup>) {
  const input = screen
    .getByRole("dialog")
    .querySelector<HTMLInputElement>('input[type="file"]');
  await user.upload(input!, file);
  await user.click(screen.getByRole("button", { name: "Upload" }));
}

describe("the upload dialog and auto-delete", () => {
  it("offers the periods, with Keep checked, when the server has the expiry", async () => {
    open({ document_expiry_enabled: true });
    const group = await screen.findByRole("radiogroup", { name: "Auto-delete" });
    expect(group).toBeVisible();
    expect(screen.getByRole("radio", { name: "Keep" })).toBeChecked();
    // It comes under the title.
    const title = screen.getByLabelText("Title");
    expect(
      title.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers nothing when the server has no expiry", async () => {
    open({ document_expiry_enabled: false });
    await screen.findByLabelText("Title");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("sends the picked period with the document", async () => {
    const user = userEvent.setup();
    const create = open({ document_expiry_enabled: true });
    await user.click(await screen.findByRole("radio", { name: "3 days" }));
    await upload(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith("Plan", file, "3d");
  });

  it("sends no period when Keep stays picked", async () => {
    const user = userEvent.setup();
    const create = open({ document_expiry_enabled: true });
    await screen.findByRole("radiogroup");
    await upload(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith("Plan", file);
  });

  it("sends no period when the server has no expiry", async () => {
    const user = userEvent.setup();
    const create = open({});
    await screen.findByLabelText("Title");
    await upload(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith("Plan", file);
  });
});
