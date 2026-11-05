import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import type { Version } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { DocProvider, type DocContextValue } from "./doc-context";
import { PreviewBanner } from "./doc-preview-banner";
import { useVersions } from "./use-versions";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const earlier = { id: "v3", number: 3, created_at: "2026-09-01T10:00:00Z" } as Version;
const newest = { id: "v8", number: 8 } as Version;

function renderBanner(props: { version?: Version; canRestore: boolean }) {
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  const client = new QueryClient();
  client.setQueryData(queryKeys.versions("doc_1"), { items: [earlier, newest] });
  render(
    <QueryClientProvider client={client}>
      <DocProvider value={doc as unknown as DocContextValue}>
        <PreviewBanner docId="doc_1" {...props} />
      </DocProvider>
    </QueryClientProvider>,
  );
  return doc;
}

// Each restore answers with the next new version, or fails with the status
// it is given. Other requests read the history.
function stubRestores(...answers: (Version | number)[]) {
  const fetch = vi.fn(async (url: string) => {
    const answer = url.endsWith("/restore")
      ? answers.shift()
      : { items: [earlier, newest] };
    return typeof answer === "number"
      ? new Response(JSON.stringify({ error: "unavailable" }), { status: answer })
      : new Response(JSON.stringify(answer), {
          headers: { "Content-Type": "application/json" },
        });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The Undo action of the "Restored." toast.
async function undoAction() {
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  const [message, options] = vi.mocked(toast.success).mock.calls[0];
  expect(message).toBe("Restored an earlier version of “Untitled”.");
  const action = options?.action as { label: string; onClick: () => void };
  expect(action.label).toBe("Undo");
  return action.onClick;
}

it("says when the previewed entry is from and goes back to the current document", () => {
  stubRestores();
  const doc = renderBanner({ version: earlier, canRestore: false });
  expect(screen.getByRole("status")).toHaveTextContent(
    "This is the document as it was",
  );
  expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Current document" }));
  expect(doc.showLatest).toHaveBeenCalledOnce();
});

it("restores the previewed entry and shows the restored document", async () => {
  const fetch = stubRestores({ id: "v9", number: 9 });
  const doc = renderBanner({ version: earlier, canRestore: true });
  fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
  await waitFor(() => expect(doc.stayOnVersion).toHaveBeenCalledWith("v9"));
  expect(doc.showLatest).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith(
    "/v1/documents/doc_1/versions/v3/restore",
    expect.objectContaining({ method: "POST" }),
  );
});

it("undoes a restore by restoring the entry that was the newest", async () => {
  const fetch = stubRestores({ id: "v9", number: 9 }, { id: "v10", number: 10 });
  const doc = renderBanner({ version: earlier, canRestore: true });
  fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
  (await undoAction())();
  const [undone, messages] = vi.mocked(toast.promise).mock.calls[0];
  await undone;
  expect(fetch).toHaveBeenCalledWith(
    "/v1/documents/doc_1/versions/v8/restore",
    expect.objectContaining({ method: "POST" }),
  );
  expect(doc.stayOnVersion).toHaveBeenLastCalledWith("v10");
  expect(messages).toMatchObject({ success: "Undid the restore of “Untitled”." });
});

it("says when the undo fails", async () => {
  stubRestores({ id: "v9", number: 9 }, 503);
  renderBanner({ version: earlier, canRestore: true });
  fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
  (await undoAction())();
  const [undone, messages] = vi.mocked(toast.promise).mock.calls[0];
  await expect(undone).rejects.toThrow();
  const error = (messages as { error: (e: unknown) => string }).error;
  expect(error(undefined)).toBe("Could not undo the restore.");
});

it("still warns before the history loads", () => {
  stubRestores();
  renderBanner({ canRestore: true });
  expect(screen.getByRole("status")).toHaveTextContent(
    "This is an earlier state of the document.",
  );
});

it("says that the history did not load, with Retry, and does not just drop Restore", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fail
        ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ items: [earlier, newest] }), {
            headers: { "Content-Type": "application/json" },
          }),
    ),
  );
  // The document page finds the entry in the history that it reads.
  function Banner() {
    const versions = useVersions("doc_1");
    const version = versions.data?.items.find((v) => v.id === earlier.id);
    return <PreviewBanner docId="doc_1" version={version} canRestore />;
  }
  const doc = { showLatest: vi.fn(), stayOnVersion: vi.fn() };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DocProvider value={doc as unknown as DocContextValue}>
        <Banner />
      </DocProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText(/The history did not load\./)).toBeVisible();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: /Restore/ })).toBeVisible();
});
