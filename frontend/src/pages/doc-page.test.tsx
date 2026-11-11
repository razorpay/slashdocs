import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPage } from "./doc-page";
import type { DocWorkspace } from "./doc-workspace";

// The workspace shows what the page gives it: the version on screen, the
// latest one, and the banner. Its button holds an update, as the frame does.
vi.mock("./doc-workspace", () => ({
  DocWorkspace: (props: Parameters<typeof DocWorkspace>[0]) => (
    <div>
      <p>
        on {props.version}, latest {props.latest}
      </p>
      <button
        onClick={() =>
          props.holdUpdate?.({
            authors: [{ type: "user", id: "usr_a", name: "Asha" }],
          })
        }
      >
        Hold
      </button>
      {props.banner?.(false)}
    </div>
  ),
}));

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// installFetch answers the document with each status in turn, then with the
// last one.
function installFetch(documentStatuses: number[], ownRequests: unknown[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET" });
      if (url === "/v1/me") {
        return jsonResponse({ principal: { type: "user", id: "usr_reader" } });
      }
      if (url === "/v1/documents/doc_1") {
        const status = documentStatuses.shift() ?? 500;
        if (!documentStatuses.length) documentStatuses.push(status);
        return jsonResponse({ error: { code: "error", message: "no" } }, status);
      }
      if (url === "/v1/documents/doc_1/access-requests") {
        return jsonResponse({ items: ownRequests });
      }
      return jsonResponse({ items: [] });
    }),
  );
  const eventSource = vi.fn();
  vi.stubGlobal("EventSource", eventSource);
  return { calls, eventSource };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/d/doc_1"]}>
        <Routes>
          <Route path="/app/d/:id" element={<DocumentPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DocumentPage", () => {
  it("shows a request that waits as sent, and does not join the document", async () => {
    const { calls, eventSource } = installFetch(
      [403],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    expect(await screen.findByRole("button", { name: /Request sent/ })).toBeDisabled();
    expect(eventSource).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.includes("/presence"))).toBe(false);
  });

  it("offers a request when none waits", async () => {
    installFetch([403]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request access/ })).toBeEnabled(),
    );
  });

  it("loads the document again on Retry", async () => {
    const { calls } = installFetch([500, 403]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("You don't have access to this document"),
    ).toBeVisible();
    // The load, Retry, and the first check of the page that waits for access.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/v1/documents/doc_1")).toHaveLength(
        3,
      ),
    );
  });

  it("checks access again on Check access, and says that it is still missing", async () => {
    const { calls } = installFetch(
      [403],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Check access" }));
    expect(await screen.findByText(/You still don't have access/)).toBeVisible();
    expect(calls.filter((call) => call.url === "/v1/documents/doc_1")).toHaveLength(3);
  });

  it("says that Check access failed, not that access is still missing", async () => {
    installFetch(
      [403, 403, 503],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Check access" }));
    expect(await screen.findByText(/Could not check access/)).toBeVisible();
    expect(screen.queryByText(/You still don't have access/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check access" })).toBeEnabled();
  });

  it("asks for the document again while the reader waits for access", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = installFetch([403]);
    renderPage();
    await screen.findByText("You don't have access to this document");
    const asked = () => calls.filter((call) => call.url === "/v1/documents/doc_1");
    await waitFor(() => expect(asked()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(asked()).toHaveLength(3));
    // The page that waits does not blink to a load while it asks.
    expect(screen.getByText("You don't have access to this document")).toBeVisible();
  });
});

describe("a document that changes", () => {
  // The stream of the page, which a test sends events on.
  class Stream {
    static last: Stream;
    listeners = new Map<string, (message: MessageEvent) => void>();
    onopen?: () => void;
    constructor() {
      Stream.last = this;
    }
    addEventListener(kind: string, listener: (message: MessageEvent) => void) {
      this.listeners.set(kind, listener);
    }
    send(event: object) {
      this.listeners.get("document")?.(
        new MessageEvent("document", { data: JSON.stringify(event) }),
      );
    }
    close() {}
  }

  // The server has the document at a version, and makes a new one on change.
  function open() {
    const server = { id: "doc_1", title: "Plan", current_version_id: "ver_1" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        jsonResponse(String(input) === "/v1/documents/doc_1" ? server : { items: [] }),
      ),
    );
    vi.stubGlobal("EventSource", Stream);
    renderPage();
    const change = (version: string) => {
      server.current_version_id = version;
      act(() => Stream.last.send({ data: { version_id: version } }));
    };
    return { change };
  }

  const banner = () => screen.queryByRole("status");

  it("stays on the version on screen, and learns the latest one from the event", async () => {
    const { change } = open();
    await screen.findByText("on ver_1, latest ver_1");

    change("ver_2");

    expect(screen.getByText("on ver_1, latest ver_2")).toBeVisible();
    expect(banner()).toBeNull();
  });

  it("offers the latest version when the page stays behind", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { change } = open();
    await screen.findByText("on ver_1, latest ver_1");

    change("ver_2");
    await act(() => vi.advanceTimersByTimeAsync(1400));
    expect(banner()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(banner()).toHaveTextContent("This document changed.");

    await userEvent.click(screen.getByRole("button", { name: "Show the latest" }));
    expect(screen.getByText("on ver_2, latest ver_2")).toBeVisible();
    expect(banner()).toBeNull();
  });

  it("shows at once the change that the frame holds for the reader", async () => {
    const { change } = open();
    await screen.findByText("on ver_1, latest ver_1");

    change("ver_2");
    await userEvent.click(screen.getByRole("button", { name: "Hold" }));

    expect(banner()).toHaveTextContent("Asha updated this document.");
  });

  it("asks for the document again when the stream opens", async () => {
    open();
    await screen.findByText("on ver_1, latest ver_1");
    const asked = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/v1/documents/doc_1");
    const before = asked().length;

    act(() => Stream.last.onopen?.());

    await waitFor(() => expect(asked().length).toBeGreaterThan(before));
  });
});
