import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @ts-expect-error The app tsconfig intentionally omits Node types; Vitest's test tsconfig includes them.
import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveDocumentDialog } from "./move-document-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type TestVisualViewport = Omit<VisualViewport, "height" | "offsetTop"> & {
  height: number;
  offsetTop: number;
  emit: (type: string) => void;
};

function createVisualViewport(initial: { height: number; offsetTop: number }) {
  const listeners = new Map<string, Set<() => void>>();
  const visualViewport = {
    height: initial.height,
    offsetTop: initial.offsetTop,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const callbacks = listeners.get(type) || new Set<() => void>();
      callbacks.add(listener);
      listeners.set(type, callbacks);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    emit(type: string) {
      listeners.get(type)?.forEach((listener) => listener());
    },
  } as unknown as TestVisualViewport;

  return visualViewport;
}

function Harness({ currentFolder }: { currentFolder?: { id: string; title: string } }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={client}>
      <MoveDocumentDialog
        open={open}
        onOpenChange={setOpen}
        docId="doc_1"
        currentFolder={currentFolder}
      />
    </QueryClientProvider>
  );
}

describe("MoveDocumentDialog", () => {
  it("tracks the VisualViewport while open and removes listeners when closed", async () => {
    const visualViewport = createVisualViewport({ height: 420, offsetTop: 18 });
    vi.stubGlobal("visualViewport", visualViewport);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
          has_more: false,
        }),
      ),
    );

    const user = userEvent.setup();
    render(<Harness />);
    const dialog = screen.getByRole("dialog");

    await waitFor(() => {
      expect(dialog.style.getPropertyValue("--move-dialog-viewport-height")).toBe(
        "420px",
      );
      expect(dialog.style.getPropertyValue("--move-dialog-viewport-offset-top")).toBe(
        "18px",
      );
    });
    expect(visualViewport.addEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
    expect(visualViewport.addEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );

    visualViewport.height = 286;
    visualViewport.offsetTop = 64;
    visualViewport.emit("resize");
    await waitFor(() => {
      expect(dialog.style.getPropertyValue("--move-dialog-viewport-height")).toBe(
        "286px",
      );
      expect(dialog.style.getPropertyValue("--move-dialog-viewport-offset-top")).toBe(
        "64px",
      );
    });

    visualViewport.offsetTop = 92;
    visualViewport.emit("scroll");
    await waitFor(() =>
      expect(dialog.style.getPropertyValue("--move-dialog-viewport-offset-top")).toBe(
        "92px",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );
      expect(visualViewport.removeEventListener).toHaveBeenCalledWith(
        "scroll",
        expect.any(Function),
      );
    });
  });

  it("keeps the scoped CSS fallback when VisualViewport is unavailable", async () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ items: [], has_more: false })),
    );

    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(screen.getByText("No folders found.")).toBeVisible());

    expect(dialog.style.getPropertyValue("--move-dialog-viewport-height")).toBe("");
    expect(dialog).toHaveClass("move-dialog-content");

    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain("--move-dialog-viewport-height: 100dvh;");
    expect(styles).toContain(
      "var(--move-dialog-viewport-offset-top) + var(--move-dialog-viewport-height) -\n        min(var(--move-dialog-viewport-height), 560px)",
    );
    expect(styles).toContain("bottom: auto;");
  });

  it("keeps the search and result viewport stable while using crisp pointer motion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
          has_more: false,
        }),
      ),
    );

    render(<Harness />);

    expect(screen.getByRole("dialog")).toHaveClass(
      "move-dialog-content",
      "flex",
      "flex-col",
    );
    expect(screen.getByRole("combobox")).toHaveClass("pl-10");
    expect(screen.getByRole("listbox")).toHaveClass(
      "move-dialog-list",
      "h-64",
      "min-h-64",
      "max-h-64",
      "overscroll-contain",
    );
    expect(screen.getByRole("button", { name: "Cancel" }).parentElement).toHaveClass(
      "move-dialog-footer",
      "shrink-0",
    );

    const option = await screen.findByRole("option", { name: /Target/ });
    expect(option).toHaveClass("move-dialog-option");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
    expect(option).toHaveAttribute("tabindex", "-1");
    expect(option).toHaveClass(
      "motion-safe:transition-[transform,opacity]",
      "motion-safe:duration-150",
      "motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]",
      "motion-safe:active:scale-[0.985]",
    );
    expect(option).not.toHaveClass("transition-colors");
  });

  it("supports Home and End navigation without changing selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            { type: "folder", folder: { id: "fld_one", title: "One" } },
            { type: "folder", folder: { id: "fld_two", title: "Two" } },
            { type: "folder", folder: { id: "fld_three", title: "Three" } },
          ],
          has_more: false,
        }),
      ),
    );

    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("combobox");

    await screen.findByRole("option", { name: /Three/ });
    await user.click(input);
    await user.keyboard("{End}");
    expect(input).toHaveAttribute("aria-activedescendant", "move-folder-fld_three");

    await user.keyboard("{Home}");
    expect(input).toHaveAttribute("aria-activedescendant", "move-folder-fld_one");
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("shows root only for a foldered document and excludes its current folder", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            type: "folder",
            folder: { id: "fld_current", title: "Current" },
          },
          {
            type: "folder",
            folder: {
              id: "fld_target",
              title: "Runbooks",
              ancestors: [{ id: "fld_parent", title: "Payments" }],
              ancestors_truncated: true,
              owner: { type: "user", id: "usr_owner", name: "Owner" },
            },
          },
        ],
        has_more: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness currentFolder={{ id: "fld_current", title: "Current" }} />);

    expect(await screen.findByRole("option", { name: /Workspace root/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Current/ })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: /Payments \/ Runbooks.*Owner: Owner/ }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/folders?q=&min_role=editor",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends a folder source and presents the server warning accessibly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          document_id: "doc_1",
          moved: true,
          permission_warning: { message: "Inherited access may change." },
        });
      }
      return jsonResponse({
        items: [
          { type: "folder", folder: { id: "fld_current", title: "Current" } },
          { type: "folder", folder: { id: "fld_target", title: "Target" } },
        ],
        has_more: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Harness currentFolder={{ id: "fld_current", title: "Current" }} />);

    await user.click(await screen.findByRole("option", { name: /Target/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/v1/folders/fld_target/documents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            document_id: "doc_1",
            expected_source: { kind: "folder", folder_id: "fld_current" },
          }),
        }),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Access may change" }),
    ).toBeVisible();
    expect(screen.getByText("Inherited access may change.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Got it" })).toBeVisible();
  });

  it("never offers workspace root for a root document and sends the canonical source", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ document_id: "doc_1", moved: true });
      }
      return jsonResponse({
        items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
        has_more: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Harness />);

    expect(
      screen.queryByRole("option", { name: "Workspace root" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Target/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/v1/folders/fld_target/documents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            document_id: "doc_1",
            expected_source: { kind: "root" },
          }),
        }),
      ),
    );
  });

  it.each([
    [403, "forbidden", "You do not have permission to move this document."],
    [409, "source_changed", "The document changed location. Refresh and try again."],
  ])(
    "keeps the dialog open and explains a %s move failure",
    async (status, code, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "POST") {
            return jsonResponse({ error: { code, message: "server detail" } }, status);
          }
          return jsonResponse({
            items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
            has_more: false,
          });
        }),
      );

      const user = userEvent.setup();
      render(<Harness />);
      await user.click(await screen.findByRole("option", { name: /Target/ }));
      await user.click(screen.getByRole("button", { name: "Move" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("dialog", { name: "Move document" })).toBeVisible();
    },
  );

  it("prevents canceling while a move request is pending", async () => {
    let resolveMove!: (response: Response) => void;
    const pendingMove = new Promise<Response>((resolve) => {
      resolveMove = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return pendingMove;
        return jsonResponse({
          items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
          has_more: false,
        });
      }),
    );

    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByRole("option", { name: /Target/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "Move document" })).toBeVisible();
    resolveMove(
      jsonResponse({ document_id: "doc_1", folder_id: "fld_target", moved: true }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Move document" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows a retryable folder error and keeps Move disabled without a destination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Folder service unavailable" } }, 503),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ type: "folder", folder: { id: "fld_target", title: "Target" } }],
          has_more: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<Harness />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder service unavailable",
    );
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    expect(screen.queryByText("No folders found.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: /Target/ })).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/folders?q=&min_role=editor",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
