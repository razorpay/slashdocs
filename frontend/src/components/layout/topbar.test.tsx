import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountMenu, GetStarted, InboxMenu } from "./topbar";

describe("AccountMenu", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("opens the setup guide and keeps its progress", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "slashdocs.onboarding",
      JSON.stringify({ status: "active", path: "cli", steps: { cli_installed: true } }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/app/documents"]}>
            <Routes>
              <Route
                path="/app/documents"
                element={<AccountMenu user={{ type: "user", id: "usr_1" }} />}
              />
              <Route path="/app/start" element={<GetStarted />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Setup guide" }));

    expect(
      await screen.findByRole("link", { name: "Get started: 1 of 2 complete" }),
    ).toBeInTheDocument();
  });
});

function Location() {
  const { pathname, search } = useLocation();
  return <p>{pathname + search}</p>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const ask = {
  document_id: "doc_1",
  document_title: "Plan",
  requester: { type: "user", id: "usr_ana", name: "Ana" },
  requested_at: new Date().toISOString(),
};

// stubLists answers the inbox and the requests for access.
function stubLists(inbox: () => Response, requests: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/v1/me/inbox") ? inbox() : requests(),
    ),
  );
}

function renderInbox(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/app/documents"]}>
          <Routes>
            <Route path="/app/documents" element={<InboxMenu />} />
            <Route path="/app/d/:id" element={<Location />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("InboxMenu", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists what waits on the reader, and opens each in its place", async () => {
    const now = new Date().toISOString();
    const raj = { type: "user", id: "usr_raj", name: "Raj" };
    stubLists(
      () =>
        json({
          items: [
            {
              kind: "thread",
              document_id: "doc_2",
              document_title: "Spec",
              comment_id: "cmt_1",
              from: raj,
              body: "Why three?",
              at: now,
            },
            {
              kind: "approval",
              document_id: "doc_3",
              document_title: "Launch",
              from: raj,
              at: now,
            },
          ],
        }),
      () => json({ items: [ask] }),
    );
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByRole("button", { name: "Inbox, 3 items" }));
    // Each row starts with the initial of its person.
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "RLaunchRaj asked just now",
      "RRaj on SpecWhy three?",
      "AAna asks for PlanAsked just now",
    ]);
    await user.click(screen.getByRole("menuitem", { name: /Raj on Spec/ }));
    expect(await screen.findByText("/app/d/doc_2?comment=cmt_1")).toBeInTheDocument();
  });

  it("opens the approvals of a document to approve, and the share sheet of a request", async () => {
    stubLists(
      () =>
        json({
          items: [
            {
              kind: "approval",
              document_id: "doc_3",
              document_title: "Launch",
              from: { type: "user", id: "usr_raj" },
              at: new Date().toISOString(),
            },
          ],
        }),
      () => json({ items: [] }),
    );
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole("button", { name: "Inbox, 1 item" }));
    await user.click(screen.getByRole("menuitem", { name: /Launch/ }));
    expect(await screen.findByText("/app/d/doc_3?approvals=1")).toBeInTheDocument();
  });

  it("shows nothing when nothing waits", async () => {
    const fetch = vi.fn(async () => json({ items: [] }));
    vi.stubGlobal("fetch", fetch);
    renderInbox();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks a list that did not load, and loads both on Retry", async () => {
    let fail = true;
    stubLists(
      () => json({ items: [] }),
      () =>
        fail ? json({ error: { code: "unavailable" } }, 503) : json({ items: [ask] }),
    );
    const user = userEvent.setup();
    renderInbox(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    await user.click(await screen.findByRole("button", { name: "Inbox did not load" }));
    expect(screen.getByText("Could not load the inbox.")).toBeVisible();
    fail = false;
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(
      await screen.findByRole("menuitem", { name: /Ana asks for Plan/ }),
    ).toBeVisible();
    // The open menu hides the rest of the page from the accessibility tree.
    expect(
      screen.getByRole("button", { name: "Inbox, 1 item", hidden: true }),
    ).toBeVisible();
  });
});
