import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalApp } from "./app";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.pushState({}, "", "/");
});

const DAY = 24 * 3_600_000;

it("marks a document that expires in the listing, and no other", async () => {
  history.pushState({}, "", "/");
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/_/api/entry/")
        return json({
          type: "folder",
          path: "",
          title: "",
          dir: "/home/docs",
          modified: "2026-11-18T10:00:00Z",
          entries: [
            {
              type: "document",
              path: "scratch.html",
              title: "Scratch",
              modified: "2026-11-18T10:00:00Z",
              expires_at: new Date(Date.now() + 3 * DAY + 60_000).toISOString(),
            },
            {
              type: "document",
              path: "kept.html",
              title: "Kept",
              modified: "2026-11-18T10:00:00Z",
            },
          ],
        });
      return new Response("{}", { status: 404 });
    }),
  );
  render(<LocalApp />);

  const mark = await screen.findByRole("img", { name: /Deletes in 3 days/ });
  expect(mark).toHaveTextContent("3 days");
  expect(screen.getAllByRole("img", { name: /Deletes/ })).toHaveLength(1);
  // It sits in the row of Scratch, and it is no control.
  expect(mark.closest("tr")).toHaveTextContent("Scratch");
  expect(screen.queryByRole("button", { name: /Deletes/ })).toBeNull();
});
