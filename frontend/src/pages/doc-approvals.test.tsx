import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalListItem, ApprovalStatus, Principal } from "@/api";
import { clearFieldDrafts, readFieldDraft } from "@/lib/field-drafts";
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
  // The server refuses each decision: people type in the document.
  superseded?: boolean;
  // The role of each address on the document ("anyone" for everyone). Without
  // it, the access does not load, and the server decides.
  roles?: Record<string, string>;
  // The approver cannot open the document until it is shared with them.
  noAccess?: boolean;
  // The approvers list, and the user search, fail with these statuses.
  approversStatus?: number;
  usersStatus?: number;
  // Adding an approver fails with this status once the person can open the
  // document.
  addStatus?: number;
  // Every write waits for this before it answers.
  held?: Promise<unknown>;
};

// Decisions the page posted, in order.
type PostedDecision = {
  version_id: string;
  decision: string;
  note?: string;
  seq?: number;
};

// The message of the server for a decision while people type.
const EDITING = "People are editing this document. Approve it when they are done.";

function installFetch(options: FetchOptions = {}, posted: PostedDecision[] = []) {
  const calls: string[] = [];
  let shared = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(init?.body ? `${url} ${String(init.body)}` : url);
      if (init?.method && init.method !== "GET") await options.held;
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url === "/v1/documents/doc_1/approvals" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as PostedDecision;
        posted.push(body);
        if (options.superseded)
          return jsonResponse(
            { error: { code: "version_superseded", message: EDITING } },
            409,
          );
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
      if (url === "/v1/documents/doc_1/versions")
        return jsonResponse({
          items: ["ver_3", "ver_2", "ver_1"].map((id) => ({
            id,
            number: Number(id.replace("ver_", "")),
          })),
        });
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
      if (url === "/v1/documents/doc_1/access") {
        if (!options.roles)
          return jsonResponse({ error: { code: "unavailable" } }, 503);
        return jsonResponse({
          current_role: "owner",
          items: Object.entries(options.roles).map(([address, role]) => ({
            principal:
              address === "anyone"
                ? { type: "anyone", id: "anyone" }
                : { type: "user", id: address, email: address },
            effective_role: role,
            sources: [],
          })),
        });
      }
      if (url === "/v1/documents/doc_1/grants" && init?.method === "POST") {
        shared = true;
        const { role } = JSON.parse(String(init.body)) as { role: string };
        return jsonResponse({ id: "grt_1", role }, 201);
      }
      if (url.startsWith("/v1/documents/doc_1/approvers") && options.approversStatus)
        return jsonResponse(
          { error: { code: "unavailable" } },
          options.approversStatus,
        );
      if (url.startsWith("/v1/users") && options.usersStatus)
        return jsonResponse({ error: { code: "unavailable" } }, options.usersStatus);
      if (url.startsWith("/v1/documents/doc_1/approvers")) {
        if (init?.method === "POST" && options.noAccess && !shared)
          return jsonResponse(
            {
              error: {
                code: "approver_no_access",
                message:
                  "That person can't open this document. Share it with them first.",
              },
            },
            400,
          );
        if (init?.method === "POST" && options.addStatus)
          return jsonResponse(
            { error: { code: "unavailable", message: "Approvers are unavailable." } },
            options.addStatus,
          );
        if (init?.method === "POST")
          return jsonResponse(
            {
              id: "apr_1",
              approver: { type: "user", id: "usr_rev", name: "Reviewer" },
            },
            201,
          );
        return jsonResponse({
          items: Object.values(options.approvalsByVersion ?? {}).flatMap((v) =>
            (v.items ?? []).map((item, i) => ({
              id: `apr_${i}`,
              approver: item.approver,
            })),
          ),
        });
      }
      if (url.startsWith("/v1/users"))
        return jsonResponse({ items: options.users ?? [] });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

// The doc bar keeps the dialog's open state, so the More menu opens it too.
function Dialog({
  defaultOpen = false,
  ...props
}: Omit<ComponentProps<typeof ApprovalsDialog>, "open" | "onOpenChange"> & {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <ApprovalsDialog {...props} open={open} onOpenChange={setOpen} />;
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
  typists: Principal[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ctx = {
    docId: "doc_1",
    version: viewedVersion,
    // The seq of the document that the frame of the approver shows.
    shownSeq: 12,
    showCurrent: vi.fn(),
    principal: OWNER,
    comments,
    commentsLoading: false,
    commentsError: false,
    setActiveComment: vi.fn(),
    typists,
  } as unknown as DocContextValue;
  const view = render(
    <QueryClientProvider client={client}>
      <DocProvider value={ctx}>
        <Dialog
          status={props.status}
          approved={props.approved}
          total={props.total}
          isOwner={props.isOwner ?? false}
          defaultOpen={props.defaultOpen}
        />
      </DocProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, ctx };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearFieldDrafts();
});

describe("ApprovalsDialog", () => {
  it.each([
    ["pending", "Approvals: pending, 1 of 3 approved", "--color-warning", ""],
    ["approved", "Approvals: 3 of 3 approved", "--color-success", ""],
    ["rejected", "Approvals: rejected, 1 of 3 approved", "--color-danger", "!"],
  ] as const)(
    "names the state and the count of %s approvals on the icon, which a badge marks",
    async (status, name, color, glyph) => {
      installFetch();
      renderDialog({ status, approved: status === "approved" ? 3 : 1, total: 3 });
      const icon = await screen.findByRole("button", { name });
      // The badge shows the state by its color and glyph alone.
      const badge = icon.querySelector('span[aria-hidden="true"]')!;
      expect(badge.className).toContain(color);
      expect(badge.textContent).toBe(glyph);
      expect(!!badge.querySelector("svg")).toBe(!glyph);
    },
  );

  it("leads with the blocker when someone rejected", async () => {
    installFetch({
      approvalsByVersion: { ver_2: { status: "rejected", approved: 1, total: 3 } },
    });
    renderDialog({ status: "rejected", approved: 1, total: 3 });
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Approvals: rejected, 1 of 3 approved",
      }),
    );
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
        await screen.findByRole("button", { name: /^Approvals: / }),
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
    // The dialog opens with the focus in the field.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Approver" })).toHaveFocus(),
    );
    // With no approvers there is no empty list between the status and the
    // field.
    expect(
      screen.getByText("No approvers assigned").parentElement?.nextElementSibling
        ?.tagName,
    ).toBe("FORM");
  });

  it("holds no place for a list while the decisions of a document with no approvers load", async () => {
    installFetch();
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/v1/documents/doc_1/approvals")
        ? new Promise(() => {})
        : answer(input, init),
    );
    renderDialog({ isOwner: true, defaultOpen: true });
    const field = await screen.findByRole("combobox", { name: "Approver" });
    // Only the status line, which keeps its height, is above the field.
    expect(
      field.closest("form")?.previousElementSibling?.previousElementSibling,
    ).toBeNull();
  });

  it("says that the people search failed, with Retry, and keeps a full address", async () => {
    installFetch({ usersStatus: 503 });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Approver" });
    await user.type(input, "rev");
    expect(await screen.findByText(/Could not search people/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    await user.type(input, "iewer@example.com");
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("says that the approvers did not load, and keeps Remove off with the reason", async () => {
    const reviewer: Principal = { type: "user", id: "rev", name: "Rev" };
    installFetch({
      approversStatus: 503,
      approvalsByVersion: {
        ver_2: {
          status: "pending",
          approved: 0,
          total: 1,
          items: [{ approver: reviewer, decision: null }],
        },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1, isOwner: true });
    await userEvent.click(await screen.findByRole("button", { name: /^Approvals: / }));
    expect(await screen.findByText(/Could not load the approvers/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Remove Rev as approver/ }),
    ).toBeDisabled();
  });

  it("picks an approver from the suggestions with the keyboard", async () => {
    const calls = installFetch({
      users: [{ id: "usr_rev", email: "reviewer@example.com", name: "Reviewer" }],
      roles: { "reviewer@example.com": "editor" },
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
    // A pick adds the person, who can edit the document.
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls).toContain(
        '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each([
    [{}, "No access", "can't open"],
    [{ "reviewer@example.com": "viewer" }, "Viewer", "can only view"],
    [{ anyone: "commenter" }, "Commenter", "can only comment on"],
  ])(
    "asks to give editor access to a person who cannot edit, then adds them (%j)",
    async (roles, note, can) => {
      const calls = installFetch({
        users: [{ id: "usr_rev", email: "reviewer@example.com", name: "Reviewer" }],
        roles,
      });
      renderDialog({ isOwner: true, defaultOpen: true });
      const user = userEvent.setup();
      const input = await screen.findByRole("combobox", { name: "Approver" });
      await user.type(input, "rev");
      // The row says what the person can do now, and they can be picked.
      const option = await screen.findByRole("option", { name: /Reviewer/ });
      await waitFor(() => expect(option).toHaveTextContent(note));
      await user.keyboard("{Enter}");

      const confirm = await screen.findByRole("alertdialog", {
        name: "Give Reviewer editor access?",
      });
      expect(confirm).toHaveTextContent(
        `Reviewer ${can} this document. Give them editor access and add them as an approver?`,
      );
      const success = vi.spyOn(toast, "success");
      await user.click(
        within(confirm).getByRole("button", { name: "Give access and add" }),
      );

      await waitFor(() =>
        expect(success).toHaveBeenCalledWith(
          "Gave Reviewer editor access and added them as approver.",
        ),
      );
      expect(calls.filter((c) => c.includes("reviewer@example.com"))).toEqual([
        '/v1/documents/doc_1/grants {"address":"reviewer@example.com","role":"editor"}',
        '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
      ]);
      expect(input).toHaveFocus();
    },
  );

  it("gives no access and adds nobody on Cancel, and the focus goes back to the search", async () => {
    const calls = installFetch({ roles: {} });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Approver" });
    await user.type(input, "reviewer@example.com");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const confirm = await screen.findByRole("alertdialog", {
      name: "Give reviewer@example.com editor access?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(input).toHaveFocus();
    expect(input).toHaveValue("reviewer@example.com");
    expect(calls.filter((c) => c.includes("reviewer@example.com"))).toEqual([]);
    // The approvals dialog stays open.
    expect(screen.getByRole("dialog", { name: "Approvals" })).toBeVisible();
  });

  it("asks when the access did not load and the server says the person cannot open it", async () => {
    const calls = installFetch({ noAccess: true });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Approver" });
    await user.type(input, "reviewer@example.com{Enter}");

    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("reviewer@example.com can't open this document.");
    await user.click(
      within(confirm).getByRole("button", { name: "Give access and add" }),
    );
    await waitFor(() => expect(input).toHaveValue(""));
    expect(calls.filter((c) => c.includes("reviewer@example.com"))).toEqual([
      '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
      '/v1/documents/doc_1/grants {"address":"reviewer@example.com","role":"editor"}',
      '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("picks the only match with one Enter", async () => {
    const calls = installFetch({
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
    await waitFor(() =>
      expect(calls).toContain(
        '/v1/documents/doc_1/approvers {"address":"reviewer@example.com"}',
      ),
    );
  });

  it("says that the approvals did not load, and offers Retry", async () => {
    installFetch({ approvalsStatus: 503 });
    renderDialog({ status: "pending", approved: 0, total: 1, isOwner: true });
    await userEvent.click(await screen.findByRole("button", { name: /^Approvals: / }));
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
    await userEvent.click(await screen.findByRole("button", { name: /^Approvals: / }));

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

    expect(
      await screen.findByRole("button", {
        name: "Approvals: rejected, 0 of 1 approved",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Approvals: 1 of 1 approved" }),
    ).toBeNull();
  });

  it("never shows the current counts for an older version whose approvals fail", async () => {
    installFetch({ currentVersionID: "ver_3", approvalsStatus: 503 });
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_2");

    const chip = await screen.findByRole("button", { name: "Approvals did not load" });
    expect(screen.queryByText(/0 of 1 approved/)).toBeNull();
    await userEvent.click(chip);
    expect(await screen.findByText("Could not load approvals")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("uses the document status when the latest version is on screen", async () => {
    const calls = installFetch({ currentVersionID: "ver_2" });
    renderDialog({ status: "approved", approved: 2, total: 2 }, "ver_2");

    expect(
      await screen.findByRole("button", { name: "Approvals: 2 of 2 approved" }),
    ).toBeTruthy();
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
    await userEvent.click(await screen.findByRole("button", { name: /^Approvals: / }));
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
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "rejected", seq: 12 });
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
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "approved", seq: 12 });
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
    expect(posted[0]).toEqual({ version_id: "ver_2", decision: "approved", seq: 12 });
  });

  it("shows the message of a refused decision as it is, with no Approved toast, and keeps the decision open", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const posted: PostedDecision[] = [];
    const calls = installFetch(
      { approvalsByVersion: { ver_2: pendingOwn }, superseded: true },
      posted,
    );
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_2", [
      comment("c1"),
    ]);
    await openApprovals();
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    calls.length = 0;
    await userEvent.click(screen.getByRole("button", { name: "Approve anyway" }));

    await waitFor(() => expect(error).toHaveBeenCalledExactlyOnceWith(EDITING));
    expect(success).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    // The approver can decide again when the people are done.
    expect(screen.getByRole("button", { name: "Approve anyway" })).toBeEnabled();
    expect(screen.queryByText("Approved")).toBeNull();
    // The document and the decisions load again.
    await waitFor(() => expect(calls).toContain("/v1/documents/doc_1"));
  });

  it("waits while another person types, and says who", async () => {
    installFetch({ approvalsByVersion: { ver_2: pendingOwn } });
    const admin: Principal = { type: "user", id: "admin", name: "admin" };
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_2", [], [admin]);
    await openApprovals();

    expect(await screen.findByRole("button", { name: "Approve" })).toBeDisabled();
    expect(
      screen.getByText("admin is editing. You can approve when they stop."),
    ).toBeVisible();
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

// A reason is kept until the reviewer sends or discards it, and it never
// moves to new content unless the reviewer says so.
describe("the reason of a rejection", () => {
  const pendingOwn = {
    status: "pending" as ApprovalStatus,
    approved: 0,
    total: 1,
    items: [{ approver: OWNER, decision: null } as ApprovalListItem],
  };
  const approvals = { ver_2: pendingOwn, ver_3: pendingOwn };
  const REASON = "IMPORTANT REJECTION REASON DURING LIVE UPDATE";

  async function openReject(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Approvals: / }));
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    return screen.findByRole("dialog", { name: "Reject" });
  }

  it("keeps the dialog and the reason when a new version comes, and rejects it only when the reviewer says so", async () => {
    const posted: PostedDecision[] = [];
    const options: FetchOptions = { approvalsByVersion: approvals };
    installFetch(options, posted);
    const { client, ctx } = renderDialog({ status: "pending", approved: 0, total: 1 });
    const user = userEvent.setup();
    const dialog = await openReject(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), REASON);

    options.currentVersionID = "ver_3";
    await client.invalidateQueries();
    expect(
      await within(dialog).findByText(
        "A new version was published. You wrote this reason for version 2.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Reject" })).toBe(dialog);
    expect(within(dialog).getByRole("textbox", { name: "Reason" })).toHaveValue(REASON);
    const submit = within(dialog).getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();
    // The reason is kept for a reload too.
    await waitFor(() => expect(readFieldDraft("reject:doc_1")?.body).toBe(REASON));

    await user.click(
      within(dialog).getByRole("button", { name: "Use it for version 3" }),
    );
    expect(ctx.showCurrent).toHaveBeenCalled();
    await user.click(submit);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      version_id: "ver_3",
      decision: "rejected",
      note: REASON,
      seq: 12,
    });
  });

  it("gives the reason back after a close, says what it was for, and lets the reviewer discard it", async () => {
    installFetch({ approvalsByVersion: approvals });
    renderDialog({ status: "pending", approved: 0, total: 1 });
    const user = userEvent.setup();
    let dialog = await openReject(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), REASON);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Reject" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    dialog = await screen.findByRole("dialog", { name: "Reject" });
    expect(within(dialog).getByRole("textbox", { name: "Reason" })).toHaveValue(REASON);
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(within(dialog).getByRole("textbox", { name: "Reason" })).toHaveValue("");
  });

  it("says so when a reason from an earlier visit was for another version", async () => {
    const posted: PostedDecision[] = [];
    const options: FetchOptions = { approvalsByVersion: approvals };
    installFetch(options, posted);
    const first = renderDialog({ status: "pending", approved: 0, total: 1 });
    const user = userEvent.setup();
    const dialog = await openReject(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), REASON);
    first.unmount();

    options.currentVersionID = "ver_3";
    renderDialog({ status: "pending", approved: 0, total: 1 }, "ver_3");
    const again = await openReject(user);
    expect(within(again).getByRole("textbox", { name: "Reason" })).toHaveValue(REASON);
    expect(
      await within(again).findByText(
        "You wrote this reason for version 2. This is version 3.",
      ),
    ).toBeTruthy();
    expect(within(again).getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});

// A late answer names what it was about, and leaves what the reader did
// since alone.
describe("late answers in approvals", () => {
  const reviewer: Principal = { type: "user", id: "rev", name: "Rev" };

  function hold() {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release };
  }

  it("names the document in a late decision, and waits for it before the next one", async () => {
    const { held, release } = hold();
    const success = vi.spyOn(toast, "success");
    installFetch({
      held,
      approvalsByVersion: {
        ver_2: {
          status: "pending",
          approved: 0,
          total: 1,
          items: [{ approver: OWNER, decision: null }],
        },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Approvals: / }));
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "No plan");
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Reject" })).toBeNull(),
    );
    // The rejection is on its way, so no other decision starts.
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    release();
    await waitFor(() => expect(success).toHaveBeenCalledWith("Rejected “Doc”."));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(
      within(await screen.findByRole("dialog", { name: "Reject" })).getByRole(
        "textbox",
        {
          name: "Reason",
        },
      ),
    ).toHaveValue("");
  });

  it("keeps an address typed while an add was on its way, and names the approver", async () => {
    const { held, release } = hold();
    const success = vi.spyOn(toast, "success");
    installFetch({ held });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Approver" });
    await user.type(input, "reviewer@example.com");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.clear(input);
    await user.type(input, "other@example.com");
    release();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Added Reviewer as approver."),
    );
    expect(input).toHaveValue("other@example.com");
  });

  it("keeps an unsent approver address through a close, and says that it came back", async () => {
    installFetch();
    const first = renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("combobox", { name: "Approver" }),
      "reviewer@example.com",
    );
    first.unmount();
    renderDialog({ isOwner: true, defaultOpen: true });
    expect(await screen.findByRole("combobox", { name: "Approver" })).toHaveValue(
      "reviewer@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("combobox", { name: "Approver" })).toHaveValue("");
  });

  it("says that the access was given when the add after it failed", async () => {
    installFetch({ roles: {}, addStatus: 503 });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("combobox", { name: "Approver" }),
      "reviewer@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(
      await screen.findByRole("button", { name: "Give access and add" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gave reviewer@example.com editor access, but could not add them as approver. Approvers are unavailable.",
    );
    expect(screen.getByRole("combobox", { name: "Approver" })).toHaveValue(
      "reviewer@example.com",
    );
  });

  it("toasts a failed add when the dialog closed before the answer", async () => {
    const { held, release } = hold();
    const error = vi.spyOn(toast, "error");
    installFetch({ held, noAccess: true });
    renderDialog({ isOwner: true, defaultOpen: true });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("combobox", { name: "Approver" }),
      "reviewer@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    release();
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "That person can't open this document. Share it with them first.",
      ),
    );
  });

  it("says that an approver was removed", async () => {
    const success = vi.spyOn(toast, "success");
    installFetch({
      approvalsByVersion: {
        ver_2: {
          status: "pending",
          approved: 0,
          total: 1,
          items: [{ approver: reviewer, decision: null }],
        },
      },
    });
    renderDialog({ status: "pending", approved: 0, total: 1, isOwner: true });
    await userEvent.click(await screen.findByRole("button", { name: /^Approvals: / }));
    const remove = await screen.findByRole("button", {
      name: "Remove Rev as approver",
    });
    await waitFor(() => expect(remove).toBeEnabled());
    await userEvent.click(remove);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Removed Rev as approver."),
    );
  });
});
