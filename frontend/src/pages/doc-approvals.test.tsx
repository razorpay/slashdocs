import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalListItem, ApprovalStatus, Principal } from "@/api";
import { ApprovalsDialog } from "./doc-approvals";
import { DocProvider, type DocContextValue } from "./doc-context";

const OWNER: Principal = { type: "user", id: "owner", email: "owner@example.com" };

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchOptions = {
  currentVersionID?: string;
  // Decisions keyed by the version the approvals endpoint is asked about.
  approvalsByVersion?: Record<
    string,
    {
      status: ApprovalStatus;
      approved: number;
      total: number;
      items?: ApprovalListItem[];
    }
  >;
  users?: Array<{ id: string; email: string; name: string }>;
  // The approvals endpoint fails with this status.
  approvalsStatus?: number;
};

// Decisions the page posted, in order.
type PostedDecision = { version_id: string; decision: string; note?: string };

function installFetch(options: FetchOptions = {}, posted: PostedDecision[] = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(init?.body ? `${url} ${String(init.body)}` : url);
      if (url === "/v1/documents/doc_1/approvals" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as PostedDecision;
        posted.push(body);
        return jsonResponse(
          {
            id: "apv_1",
            document_id: "doc_1",
            version_id: body.version_id,
            approver: OWNER,
            decision: body.decision,
          },
          201,
        );
      }
      if (url === "/v1/documents/doc_1") {
        return jsonResponse({
          id: "doc_1",
          title: "Doc",
          owner: OWNER,
          current_version_id: options.currentVersionID ?? "ver_2",
        });
      }
      if (url.startsWith("/v1/documents/doc_1/approvals") && options.approvalsStatus) {
        return jsonResponse(
          { error: { code: "unavailable", message: "Approvals are unavailable." } },
          options.approvalsStatus,
        );
      }
      if (url.startsWith("/v1/documents/doc_1/approvals")) {
        const asked = new URL(url, "http://x").searchParams.get("version") || "";
        const found = options.approvalsByVersion?.[asked];
        if (!found) return jsonResponse({ version_id: asked, summary: {}, items: [] });
        return jsonResponse({
          version_id: asked,
          version_number: Number(asked.replace("ver_", "")),
          status: found.status,
          summary: {
            total: found.total,
            approved: found.approved,
            rejected: 0,
            pending: found.total - found.approved,
          },
          items: found.items ?? [],
        });
      }
      if (url.startsWith("/v1/documents/doc_1/approvers")) {
        if (init?.method === "POST") return jsonResponse({ id: "apr_1" }, 201);
        return jsonResponse({ items: [] });
      }
      if (url.startsWith("/v1/users"))
        return jsonResponse({ items: options.users ?? [] });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderDialog(
  props: {
    status?: ApprovalStatus;
    approved?: number;
    total?: number;
    isOwner?: boolean;
    defaultOpen?: boolean;
  },
  viewedVersion = "ver_2",
  comments: unknown[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ctx = {
    docId: "doc_1",
    version: viewedVersion,
    principal: OWNER,
    comments,
    commentsLoading: false,
    commentsError: false,
    setActiveComment: vi.fn(),
  } as unknown as DocContextValue;
  return render(
    <QueryClientProvider client={client}>
      <DocProvider value={ctx}>
        <ApprovalsDialog
          status={props.status}
          approved={props.approved}
          total={props.total}
          isOwner={props.isOwner ?? false}
          defaultOpen={props.defaultOpen}
        />
      </DocProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalsDialog", () => {
  it("says how many approvers have approved on the chip", async () => {
    installFetch();
    renderDialog({ status: "pending", approved: 1, total: 3 });
    expect(await screen.findByText("1 of 3 approved")).toBeTruthy();
    // Below the sm breakpoint the chip shows only the count.
    expect(screen.getByText("1/3")).toHaveClass("sm:hidden");
    // Spelled out for screen readers, since the visible text is only the count.
    expect(
      screen.getByRole("button", {
        name: "Approval pending: 1 of 3 approved. Open approvals",
      }),
    ).toBeTruthy();
  });

  it("leads with the blocker when someone rejected", async () => {
    installFetch();
    renderDialog({ status: "rejected", approved: 1, total: 3 });
    expect(await screen.findByText("Rejected · 1 of 3 approved")).toBeTruthy();
  });

  it("opens on load for a link from a notification", async () => {
    installFetch({
      approvalsByVersion: {
        ver_2: { status: "pending", approved: 0, total: 1 },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1, defaultOpen: true });
    expect(await screen.findByRole("dialog", { name: "Approvals" })).toBeTruthy();
  });

  it.each([
    ["ver_2", "On the current document"],
    ["ver_1", "On earlier content"],
  ])(
    "says whether the status of %s is for the current document",
    async (viewed, label) => {
      installFetch({
        approvalsByVersion: {
          [viewed]: { status: "approved", approved: 1, total: 1 },
        },
      });
      renderDialog({ status: "approved", approved: 1, total: 1 }, viewed);
      await userEvent.click(
        await screen.findByRole("button", { name: /Open approvals/ }),
      );
      // The chip already carries the count, so the header says which content,
      // without version numbers.
      expect(await screen.findByText(label)).toBeTruthy();
    },
  );

  it("gives the owner a way in when no approvers are assigned yet", async () => {
    installFetch();
    renderDialog({ isOwner: true });

    // Without approvers the API omits approval_status; the owner still needs
    // a trigger, since the dialog is the only place to assign the first one.
    const trigger = await screen.findByRole("button", { name: "Request approval" });
    await userEvent.click(trigger);
    expect(await screen.findByRole("combobox", { name: "Approver" })).toBeTruthy();
    // The form says who cannot approve, so the owner is not surprised by a 400.
    expect(screen.getByText(/Anyone who edited it, in the browser/)).toBeTruthy();
  });

  it("picks an approver from the suggestions with the keyboard", async () => {
    const calls = installFetch({
      users: [{ id: "usr_rev", email: "reviewer@example.com", name: "Reviewer" }],
    });
    renderDialog({ isOwner: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Request approval" }));
    const input = await screen.findByRole("combobox", { name: "Approver" });
    const add = screen.getByRole("button", { name: "Add" });
    await user.type(input, "rev");
    // A part of an address cannot be added.
    expect(add).toBeDisabled();
    await screen.findByRole("option", { name: /Reviewer/ });

    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Reviewer/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("reviewer@example.com");
    expect(add).toBeEnabled();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls).toContain(
        '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
      ),
    );
  });

  it("picks the only match with one Enter", async () => {
    installFetch({
      users: [{ id: "usr_rev", email: "reviewer@example.com", name: "Reviewer" }],
    });
    renderDialog({ isOwner: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Request approval" }));
    const input = await screen.findByRole("combobox", { name: "Approver" });
    await user.type(input, "rev");
    expect(await screen.findByRole("option", { name: /Reviewer/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("reviewer@example.com");
  });

  it("says that the approvals did not load, and offers Retry", async () => {
    installFetch({ approvalsStatus: 503 });
    renderDialog({ status: "pending", approved: 0, total: 1, isOwner: true });
    await userEvent.click(
      await screen.findByRole("button", { name: /Open approvals/ }),
    );
    expect(await screen.findByText("Could not load approvals")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("No approvers assigned")).toBeNull();
  });

  it("shows nothing to a non-owner when no approvers are assigned", async () => {
    installFetch();
    renderDialog({ isOwner: false });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /approval/i })).toBeNull(),
    );
    expect(screen.queryByText("Request approval")).toBeNull();
  });

  it("shows a pending approver what they decided before the latest edits", async () => {
    const reviewer: Principal = { type: "user", id: "rev", email: "rev@example.com" };
    installFetch({
      approvalsByVersion: {
        ver_2: {
          status: "pending",
          approved: 0,
          total: 1,
          items: [
            {
              approver: reviewer,
              decision: null,
              earlier: { decision: "approved", decided_at: "2026-10-30T10:00:00Z" },
            },
          ],
        },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1 });
    await userEvent.click(
      await screen.findByRole("button", { name: /Open approvals/ }),
    );

    expect(await screen.findByText(/approved before the latest edits/)).toBeTruthy();
  });

  it("scopes the chip to the version on screen, not the latest one", async () => {
    installFetch({
      currentVersionID: "ver_3",
      approvalsByVersion: {
        ver_2: { status: "rejected", approved: 0, total: 1 },
      },
    });
    // The document's current version (v3) is approved, but v2 is on screen.
    renderDialog({ status: "approved", approved: 1, total: 1 }, "ver_2");

    expect(await screen.findByText("Rejected · 0 of 1 approved")).toBeTruthy();
    expect(screen.queryByText("1 of 1 approved")).toBeNull();
  });

  it("uses the document status when the latest version is on screen", async () => {
    const calls = installFetch({ currentVersionID: "ver_2" });
    renderDialog({ status: "approved", approved: 2, total: 2 }, "ver_2");

    expect(await screen.findByText("2 of 2 approved")).toBeTruthy();
    // No extra approvals request is needed for the common case.
    expect(calls.some((u) => u.includes("/approvals"))).toBe(false);
  });
});

describe("the approver's review actions", () => {
  const OTHER: Principal = { type: "user", id: "other", email: "other@example.com" };

  function comment(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      body: `body ${id}`,
      selected_text: `quote ${id}`,
      status: "open",
      author: OWNER,
      created_on_version_id: "ver_2",
      ...over,
    };
  }

  const pendingOwn = {
    status: "pending" as ApprovalStatus,
    approved: 0,
    total: 1,
    items: [{ approver: OWNER, decision: null } as ApprovalListItem],
  };

  async function openApprovals() {
    await userEvent.click(
      await screen.findByRole("button", { name: /Open approvals/ }),
    );
  }

  it("lists the reviewer's open comments and rejects without a reason", async () => {
    const posted: PostedDecision[] = [];
    installFetch({ approvalsByVersion: { ver_2: pendingOwn } }, posted);
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_2", [
      comment("c1"),
      comment("c2", { status: "resolved" }),
      comment("c3", { author: OTHER }),
      comment("c4", { parent_comment_id: "c1" }),
    ]);
    await openApprovals();
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    const dialog = await screen.findByRole("dialog", { name: "Reject" });
    expect(within(dialog).getByText("Your open comments (1)")).toBeTruthy();
    expect(within(dialog).getByText("body c1")).toBeTruthy();
    // Resolved, someone else's and replies are not part of the request.
    expect(within(dialog).queryByText("body c2")).toBeNull();
    expect(within(dialog).queryByText("body c3")).toBeNull();
    expect(within(dialog).queryByText("body c4")).toBeNull();

    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "rejected" });
  });

  it("needs a reason when the reviewer has no open comments", async () => {
    installFetch({ approvalsByVersion: { ver_2: pendingOwn } });
    renderDialog({ status: "pending", approved: 0, total: 1 });
    await openApprovals();
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    const dialog = await screen.findByRole("dialog", { name: "Reject" });
    const submit = within(dialog).getByRole("button", { name: "Reject" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Needs a rollback plan",
    );
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("asks before approving with open comments", async () => {
    const posted: PostedDecision[] = [];
    installFetch({ approvalsByVersion: { ver_2: pendingOwn } }, posted);
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_2", [
      comment("c1"),
    ]);
    await openApprovals();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText("You have 1 open comment. Approve anyway?"),
    ).toBeTruthy();
    expect(posted).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Approve anyway" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "approved" });
  });

  it("approves straight away when the reviewer has no open comments", async () => {
    const posted: PostedDecision[] = [];
    installFetch({ approvalsByVersion: { ver_2: pendingOwn } }, posted);
    renderDialog({ status: "pending", approved: 0, total: 1 });
    await openApprovals();
    // The decision takes the first focus, not Close.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "approved" });
  });

  it("styles Reject and Revoke as destructive buttons", async () => {
    installFetch({
      approvalsByVersion: {
        ver_2: {
          status: "approved",
          approved: 1,
          total: 1,
          items: [{ id: "apv_1", approver: OWNER, decision: "approved" }],
        },
      },
    });
    renderDialog({ status: "approved", approved: 1, total: 1 });
    await openApprovals();

    for (const name of ["Reject", "Revoke"]) {
      const button = await screen.findByRole("button", { name });
      expect(button.className).toContain("color-danger");
    }
  });

  it("shows comment counts and nudges once every comment is resolved", async () => {
    installFetch({
      approvalsByVersion: {
        ver_2: {
          status: "rejected",
          approved: 0,
          total: 1,
          items: [
            {
              id: "apv_1",
              approver: OWNER,
              decision: "rejected",
              comments_open: 0,
              comments_total: 2,
            },
          ],
        },
      },
    });
    renderDialog({ status: "rejected", approved: 0, total: 1 });
    await openApprovals();

    expect(await screen.findByText("0 open of 2 comments")).toBeTruthy();
    expect(
      screen.getByText("All your comments are resolved. Ready to approve?"),
    ).toBeTruthy();
  });
});
