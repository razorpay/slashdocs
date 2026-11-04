import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Principal } from "@/api";
import { signInPath } from "@/lib/auth-state";
import { useDoc } from "./doc-context";
import { DocWorkspace } from "./doc-workspace";

// jsdom has no media queries.
beforeEach(() => {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  vi.spyOn(api, "listComments").mockResolvedValue({ items: [] } as never);
});
afterEach(cleanup);

const reader: Principal = { type: "user", id: "u1", name: "Reader" };

// The bar shows where the page is, and whether a pin waits for its spot.
function Bar({ onToggleComments }: { onToggleComments: () => void }) {
  const { placingPin } = useDoc();
  const { pathname, search } = useLocation();
  return (
    <>
      <p>{pathname + search}</p>
      <p>{placingPin ? "Placing a pin" : "Reading"}</p>
      <button onClick={onToggleComments}>Comments</button>
    </>
  );
}

function renderWorkspace(
  entry: string,
  props: { principal?: Principal; signIn?: () => void },
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <DocWorkspace
          docId="doc-1"
          version=""
          home="/app/documents"
          {...props}
          bar={({ onToggleComments }) => <Bar onToggleComments={onToggleComments} />}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("sends a reader who is signed out to sign in, with the pin to place after", async () => {
  renderWorkspace("/app/d/doc-1?version=v1", { signIn: vi.fn() });
  await userEvent.click(screen.getByRole("button", { name: "Comments" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to comment" }),
  );
  expect(
    screen.getByText(
      signInPath({ pathname: "/app/d/doc-1", search: "?version=v1" }, "pin"),
    ),
  ).toBeInTheDocument();
});

it("places the pin once the reader is back, and forgets the intent", async () => {
  renderWorkspace("/app/d/doc-1?version=v1&intent=pin", { principal: reader });
  expect(await screen.findByText("Placing a pin")).toBeInTheDocument();
  expect(screen.getByText("/app/d/doc-1?version=v1")).toBeInTheDocument();
});

it("keeps the intent until the reader is signed in", () => {
  renderWorkspace("/app/d/doc-1?intent=pin", { signIn: vi.fn() });
  expect(screen.getByText("Reading")).toBeInTheDocument();
  expect(screen.getByText("/app/d/doc-1?intent=pin")).toBeInTheDocument();
});
