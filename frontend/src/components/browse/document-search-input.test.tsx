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
