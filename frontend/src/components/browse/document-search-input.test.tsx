import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentSearchInput } from "./document-search-input";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(responses: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    jsonResponse(responses[String(input)] || { items: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  function Harness() {
    const [value, setValue] = useState("");
    return <DocumentSearchInput value={value} onChange={setValue} />;
  }
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness />
    </QueryClientProvider>,
  );
  return {
    fetchMock,
    user: userEvent.setup(),
    input: screen.getByRole("combobox", { name: "Search documents" }),
  };
}

describe("DocumentSearchInput", () => {
  it("offers modifiers on focus and completes one with the keyboard", async () => {
    const { user, input } = setup();
    await user.click(input);
    expect(screen.getByRole("listbox", { name: "Narrow your search" })).toBeVisible();
    await user.type(input, "du");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("during:");
    expect(screen.getByRole("option", { name: /this month/i })).toBeVisible();
  });

  it("clears the query with the clear button", async () => {
    const { user, input } = setup();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    await user.type(input, "budget");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("completes a date phrase", async () => {
    const { user, input } = setup();
    await user.type(input, "budget after:last w");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("budget after:last week ");
  });

  it("autocompletes a person with keyboard navigation", async () => {
    const { user, input, fetchMock } = setup({
      "/v1/users?q=ali": {
        items: [
          { type: "user", id: "usr_alice", email: "alice@example.com", name: "Alice" },
        ],
      },
    });
    await user.type(input, "incident from:ali");
    expect(
      await screen.findByRole("option", { name: /alice@example\.com/i }),
    ).toBeVisible();
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(input).toHaveValue("incident from:alice@example.com "));
    expect(fetchMock).toHaveBeenCalledWith("/v1/users?q=ali", expect.anything());
  });

  it("says that a people search failed, not that nobody matches, and retries", async () => {
    const { user, input, fetchMock } = setup();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await user.type(input, "from:ali");
    expect(await screen.findByText("Could not search people")).toBeVisible();
    expect(screen.queryByText("No matching people")).toBeNull();

    fetchMock.mockImplementation(async () =>
      jsonResponse({
        items: [
          { type: "user", id: "usr_alice", email: "alice@example.com", name: "Alice" },
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("option", { name: /alice@example\.com/i }),
    ).toBeVisible();
    expect(input).toHaveFocus();
  });

  it("quotes a folder title that has spaces", async () => {
    const { user, input } = setup({
      "/v1/folders?q=prod": {
        items: [{ type: "folder", folder: { id: "fld_1", title: "Product Specs" } }],
      },
    });
    await user.type(input, "in:prod");
    await user.click(await screen.findByRole("option", { name: /Product Specs/ }));
    expect(input).toHaveValue('in:"Product Specs" ');
  });
});
