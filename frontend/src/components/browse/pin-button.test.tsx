import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PinButton } from "./pin-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Where() {
  return <output aria-label="Path">{useLocation().pathname}</output>;
}

it("sends one pin for presses while it waits, opens nothing, and shows the new state", async () => {
  const user = userEvent.setup();
  let pinned = false;
  vi.spyOn(api, "listPins").mockImplementation(
    async () =>
      ({
        items: pinned ? [{ resource_type: "document", resource_id: "doc_1" }] : [],
      }) as never,
  );
  let answer!: () => void;
  const put = vi
    .spyOn(api, "putPin")
    .mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined as never))),
    );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <Link to="/app/d/doc_1">
            Plan
            <PinButton resourceType="document" resourceId="doc_1" className="" />
          </Link>
          <Where />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  const pin = await screen.findByRole("button", { name: "Pin" });
  await user.click(pin);
  const busy = await screen.findByRole("button", { name: "Pin", busy: true });
  await user.click(busy);
  expect(put).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Path")).toHaveTextContent("/");
  expect(screen.getByLabelText("Path")).not.toHaveTextContent("doc_1");

  pinned = true;
  answer();
  expect(await screen.findByRole("button", { name: "Unpin" })).not.toHaveAttribute(
    "aria-busy",
  );
});

it("takes no press when the pins did not load, so that a failed list never reads as not pinned", async () => {
  const pins = vi.spyOn(api, "listPins").mockRejectedValue(new Error("503"));
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <PinButton
          resourceType="document"
          resourceId="doc_1"
          pinned={false}
          className=""
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(pins).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Pin" })).toBeDisabled(),
  );
});
