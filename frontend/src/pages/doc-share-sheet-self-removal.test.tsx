import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { ShareSheet } from "./doc-share-sheet";

// Sharing is owner-only, but a non-owner may still leave: removing their own
// grant. The affordance must exist on their own row only, must never be a
// route to the "anyone" grant that admits everyone else, and must not claim to
// have removed access that the caller still holds by another route.
const ME = { type: "user", id: "usr_me", email: "me@example.com", name: "Me" };

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function source(extra: Record<string, unknown> = {}) {
  return {
    resource_type: "document",
    resource_id: "doc_1",
    resource_title: "Doc",
    role: "commenter",
    ...extra,
  };
}

function installFetch({ generalAccess = false } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/v1/config") {
        return jsonResponse({
          deployment: "org",
          org_name: "Acme",
          everyone_label: "Anyone in Acme",
          google_groups_enabled: false,
        });
      }
      // /v1/me nests the caller under "principal"; a flat principal here would
      // let a wrong accessor in the component pass these tests.
      if (url === "/v1/me") return jsonResponse({ principal: ME, user: ME });
      if (url === "/v1/documents/doc_1/access") {
        return jsonResponse({
          current_role: "commenter",
          canonical_owner: false,
          items: [
            {
              principal: {
                type: "user",
                id: "usr_owner",
                email: "owner@example.com",
                name: "Owner",
              },
              effective_role: "owner",
              sources: [source({ role: "owner" })],
            },
            {
              principal: ME,
              effective_role: "commenter",
              sources: [source({ grant_id: "gr_self" })],
            },
            // A second grant-bearing row that is NOT the caller. Without it,
            // the caller's row is the only one carrying a grant_id and the
            // identity half of canLeave never has to hold: dropping
            // samePrincipal would still render exactly one Leave button.
            {
              principal: {
                type: "user",
                id: "usr_colleague",
                email: "colleague@example.com",
                name: "Colleague",
              },
              effective_role: "commenter",
              sources: [source({ grant_id: "gr_colleague" })],
            },
            ...(generalAccess
              ? [
                  {
                    principal: { type: "anyone", id: "" },
                    effective_role: "commenter",
                    sources: [source({ grant_id: "gr_anyone" })],
                  },
                ]
              : []),
          ],
        });
      }
      if (url.includes("/grants/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderShare({ generalAccess = false } = {}) {
  const calls = installFetch({ generalAccess });
  const onLeft = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <ShareSheet
          docId="doc_1"
          canManageAccess={false}
          isCanonicalOwner={false}
          onLeft={onLeft}
        />
      </Sheet>
    </QueryClientProvider>,
  );
  return { calls, onLeft };
}

const leaveTrigger = () => screen.findByRole("button", { name: /leave document/i });

const accessReads = (calls: Array<{ url: string; method: string }>) =>
  calls.filter((c) => c.url.endsWith("/access") && c.method === "GET").length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("non-owner sharing controls", () => {
  it("revokes only the caller's own grant when they leave", async () => {
    const { calls } = renderShare();

    await userEvent.click(await leaveTrigger());
    await userEvent.click(await screen.findByRole("button", { name: "Leave" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.url.endsWith("/grants/gr_self") && c.method === "DELETE"),
      ).toBe(true);
    });
    expect(calls.some((c) => c.url.endsWith("/grants/gr_colleague"))).toBe(false);
  });

  it("offers exactly one leave control, on the caller's row", async () => {
    renderShare();

    await leaveTrigger();
    expect(screen.getAllByRole("button", { name: /leave document/i })).toHaveLength(1);
  });

  // Leaving is irreversible now that re-adding yourself needs the owner, so it
  // must not fire on a single mis-aimed click in the slot where every other row
  // renders a dropdown.
  it("does not revoke anything until the caller confirms", async () => {
    const { calls } = renderShare();

    await userEvent.click(await leaveTrigger());

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  // The caller keeps commenter through the "anyone" grant, so deleting their
  // own row would report success while removing nothing -- and would silently
  // change their role to whatever general access confers.
  it("does not offer to leave when general access also admits the caller", async () => {
    renderShare({ generalAccess: true });

    // Wait for the access list itself, not for static chrome: the "General
    // access" heading renders before the query resolves, so asserting against
    // it would pass whether or not the row ever gets a Leave button.
    await screen.findByText("Colleague");
    expect(
      screen.queryByRole("button", { name: /leave document/i }),
    ).not.toBeInTheDocument();
  });

  // GET /access needs viewer, so refetching it right after leaving is a
  // guaranteed 403 and a red error toast on top of the green one.
  it("hands off instead of refetching access it can no longer read", async () => {
    const { calls, onLeft } = renderShare();

    await userEvent.click(await leaveTrigger());
    const before = accessReads(calls);
    await userEvent.click(await screen.findByRole("button", { name: "Leave" }));

    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(accessReads(calls)).toBe(before);
  });
});
