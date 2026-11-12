import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import { LoadError, PageError } from "./error-state";

afterEach(cleanup);

it.each([
  [new APIError(403, "forbidden", "x"), "You do not have access to this part."],
  [new APIError(404, "not_found", "x"), "It was not found. It may have moved."],
  [
    new APIError(503, "unavailable", "Raw server message"),
    "Check your connection, then try again.",
  ],
  [new TypeError("Failed to fetch"), "Check your connection, then try again."],
])(
  "says why a part did not load, never with the raw message: %s",
  async (error, text) => {
    const query = { isFetching: false, refetch: vi.fn() };
    render(
      <LoadError title="Could not load the history" error={error} query={query} />,
    );
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByText("Raw server message")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(query.refetch).toHaveBeenCalled();
  },
);

it.each([
  [new APIError(403, "forbidden", "x"), "Denied state"],
  [new APIError(404, "not_found", "x"), "Folder not found"],
  [new APIError(503, "unavailable", "x"), "Could not load folder"],
  [new TypeError("Failed to fetch"), "Could not load folder"],
])("says why a page did not load, by status: %s", (error, text) => {
  render(
    <MemoryRouter>
      <PageError
        error={error}
        what="folder"
        denied={<p>Denied state</p>}
        retry={{ isFetching: false, refetch: vi.fn() }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(text)).toBeVisible();
});
