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
};

// Decisions the page posted, in order.
type PostedDecision = { version_id: string; decision: string; note?: string };

function installFetch(options: FetchOptions = {}, posted: PostedDecision[] = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
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
      if (url.startsWith("/v1/documents/doc_1/approvals")) {
        const asked = new URL(url, "http://x").searchParams.get("version") || "";
        const found = options.approvalsByVersion?.[asked];
        if (!found) return jsonResponse({ version_id: asked, summary: {}, items: [] });
        return jsonResponse({
          version_id: asked,
          status: found.status,
          summary: {
            total: found.total,
            approved: found.approved,
            changes_requested: 0,
            pending: found.total - found.approved,
          },
          items: found.items ?? [],
        });
      }
      if (url.startsWith("/v1/documents/doc_1/approvers")) {
        return jsonResponse({ items: [] });
      }
      if (url.startsWith("/v1/users")) return jsonResponse({ items: [] });
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
    // Spelled out for screen readers, since the visible text is only the count.
    expect(
      screen.getByRole("button", {
        name: "Approval pending: 1 of 3 approved. Open approvals",
      }),
    ).toBeTruthy();
  });

  it("leads with the blocker when someone rejected", async () => {
    installFetch();
    renderDialog({ status: "changes_requested", approved: 1, total: 3 });
    expect(await screen.findByText("Rejected · 1 of 3 approved")).toBeTruthy();
  });

  it("shows the version the status is for in the dialog", async () => {
    installFetch({
      approvalsByVersion: {
        ver_2: { status: "approved", approved: 1, total: 1 },
      },
    });
    renderDialog({ status: "approved", approved: 1, total: 1 });
    await userEvent.click(
      await screen.findByRole("button", { name: /Open approvals/ }),
    );
    // The chip already carries the count, so the header says which version.
    expect(await screen.findByText("On this version")).toBeTruthy();
  });

  it("gives the owner a way in when no approvers are assigned yet", async () => {
    installFetch();
    renderDialog({ isOwner: true });

    // Without approvers the API omits approval_status; the owner still needs
    // a trigger, since the dialog is the only place to assign the first one.
    const trigger = await screen.findByRole("button", { name: "Request approval" });
    await userEvent.click(trigger);
    expect(
      await screen.findByPlaceholderText("Add approver by email or bot address…"),
    ).toBeTruthy();
    // The form says who cannot approve, so the owner is not surprised by a 400.
    expect(screen.getByText(/Anyone who has uploaded a version/)).toBeTruthy();
  });

  it("shows nothing to a non-owner when no approvers are assigned", async () => {
    installFetch();
    renderDialog({ isOwner: false });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /approval/i })).toBeNull(),
    );
    expect(screen.queryByText("Request approval")).toBeNull();
  });

  it("tells an approver who created a version that they cannot approve", async () => {
    installFetch({
      approvalsByVersion: {
        ver_2: {
          status: "pending",
          approved: 0,
          total: 1,
          items: [{ approver: OWNER, decision: null, created_version: true }],
        },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1 });
    await userEvent.click(
      await screen.findByRole("button", { name: /Open approvals/ }),
    );

    expect(
      await screen.findByText(/You created a version of this document/),
    ).toBeTruthy();
    // No decision controls for someone who cannot decide.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("scopes the chip to the version on screen, not the latest one", async () => {
    installFetch({
      currentVersionID: "ver_3",
      approvalsByVersion: {
        ver_2: { status: "changes_requested", approved: 0, total: 1 },
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
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "changes_requested" });
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
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

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
          status: "changes_requested",
          approved: 0,
          total: 1,
          items: [
            {
              id: "apv_1",
              approver: OWNER,
              decision: "changes_requested",
              comments_open: 0,
              comments_total: 2,
            },
          ],
        },
      },
    });
    renderDialog({ status: "changes_requested", approved: 0, total: 1 });
    await openApprovals();

    expect(await screen.findByText("0 open of 2 comments")).toBeTruthy();
    expect(
      screen.getByText("All your comments are resolved. Ready to approve?"),
    ).toBeTruthy();
  });
});
