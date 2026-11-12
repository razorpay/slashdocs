import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeaturedSection } from "@/api";
import { FeaturedItems } from "./featured-items";

const tutorials: FeaturedSection = {
  title: "Dev tutorials",
  description: "Read these first.",
  permanent: true,
  items: [{ type: "folder", folder: { id: "fld_setup", title: "Setup" } }],
};
const examples: FeaturedSection = {
  title: "Examples",
  permanent: false,
  items: [
    { type: "document", document: { id: "doc_guide", title: "Getting started" } },
  ],
};

function renderFeatured(sections: FeaturedSection[]) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      calls.push({ url, method });
      if (method === "DELETE") {
        sections = sections.filter((s) => s.permanent);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ items: sections }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeaturedItems />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("FeaturedItems", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("collapses a section and keeps it collapsed after a reload", async () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    vi.stubGlobal("localStorage", localStorage);
    renderFeatured([tutorials, examples]);
    await userEvent.click(await screen.findByRole("button", { name: "Examples" }));
    expect(
      screen.getByRole("button", { name: /Examples/ }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByRole("link", { name: /Getting started/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Setup/ })).toBeTruthy();

    cleanup();
    renderFeatured([tutorials, examples]);
    const toggle = await screen.findByRole("button", { name: /Examples/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(await screen.findByRole("link", { name: /Getting started/ })).toBeTruthy();
  });

  it("shows each section in order with its description and items", async () => {
    renderFeatured([tutorials, examples]);
    const headings = await screen.findAllByRole("heading");
    expect(headings.map((h) => h.textContent)).toEqual(["Dev tutorials", "Examples"]);
    expect(screen.getByText("Read these first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Setup/ }).getAttribute("href")).toBe(
      "/app/folders/fld_setup",
    );
  });

  it("offers Hide only in sections that are not permanent", async () => {
    renderFeatured([tutorials, examples]);
    const permanent = await screen.findByRole("region", { name: "Dev tutorials" });
    expect(within(permanent).queryByRole("button", { name: "Hide" })).toBeNull();
    const hideable = screen.getByRole("region", { name: "Examples" });
    expect(within(hideable).getByRole("button", { name: "Hide" })).toBeTruthy();
  });

  it("hides an item", async () => {
    const calls = renderFeatured([examples]);
    await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    expect(calls).toContainEqual({ url: "/v1/featured/doc_guide", method: "DELETE" });
  });
});
