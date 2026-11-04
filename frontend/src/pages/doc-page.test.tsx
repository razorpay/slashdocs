import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPage } from "./doc-page";

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
    expect(calls.filter((call) => call.url === "/v1/documents/doc_1")).toHaveLength(2);
  });
});
