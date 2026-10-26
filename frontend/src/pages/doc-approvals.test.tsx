import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function installFetch(options: FetchOptions = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
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
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ctx = {
    docId: "doc_1",
    version: viewedVersion,
    principal: OWNER,
    comments: [],
    commentsLoading: false,
    commentsError: false,
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
  it("names its subject on the chip", async () => {
    installFetch();
    renderDialog({ status: "pending", approved: 1, total: 3 });
    expect(await screen.findByText("Approvals: Pending 1/3")).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
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

    expect(await screen.findByText("Approvals: Changes requested")).toBeTruthy();
    expect(screen.queryByText("Approvals: Approved")).toBeNull();
  });

  it("uses the document status when the latest version is on screen", async () => {
    const calls = installFetch({ currentVersionID: "ver_2" });
    renderDialog({ status: "approved", approved: 2, total: 2 }, "ver_2");

    expect(await screen.findByText("Approvals: Approved")).toBeTruthy();
    // No extra approvals request is needed for the common case.
    expect(calls.some((u) => u.includes("/approvals"))).toBe(false);
  });
});
