import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookRail } from "./book-rail";
import { bookManifest, bookState, stubMatchMedia } from "./book-fixtures";

beforeEach(() => vi.stubGlobal("matchMedia", stubMatchMedia(false)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ shortcuts = true }: { shortcuts?: boolean }) {
  const [pinned, setPinned] = useState(false);
  return (
    <MemoryRouter>
      <input aria-label="Notes" />
      <BookRail
        manifest={bookManifest()}
        state={bookState({
          doc_1: { state: "read", updated: true },
          doc_2: { state: "reading" },
        })}
        current="doc_2"
        pinned={pinned}
        onPinnedChange={setPinned}
        shortcuts={shortcuts}
      />
    </MemoryRouter>
  );
}

describe("BookRail", () => {
  it("renders one labelled dot per visible chapter and marks the current one", () => {
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Book contents" });
    const links = within(nav)
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.includes("/c/"));
    expect(links).toHaveLength(3);
    const current = within(nav).getByRole("link", { current: "page" });
    expect(current).toHaveAccessibleName(/Title 2.*Reading/);
    expect(within(nav).getByRole("link", { name: /Title 1/ })).toHaveAccessibleName(
      /Updated/,
    );
    expect(within(nav).getByRole("link", { name: /Title 3/ })).toHaveAccessibleName(
      /Not started/,
    );
    // A planned chapter is listed but cannot be opened.
    expect(within(nav).queryByRole("link", { name: /Planned 4/ })).toBeNull();
    expect(within(nav).getByText(/Planned 4/)).toBeInTheDocument();
    expect(within(nav).getByText("Part Two")).toBeInTheDocument();
  });

  it("toggles pinned with T but not while typing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Book contents" });
    expect(nav).toHaveAttribute("data-expanded", "false");
    await user.keyboard("t");
    expect(nav).toHaveAttribute("data-expanded", "true");
    await user.keyboard("T");
    expect(nav).toHaveAttribute("data-expanded", "false");
    await user.click(screen.getByRole("textbox", { name: "Notes" }));
    await user.keyboard("t");
    expect(nav).toHaveAttribute("data-expanded", "false");
  });

  it("leaves T alone right after Esc, which is the theme chord", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard("{Escape}t");
    expect(screen.getByRole("navigation", { name: "Book contents" })).toHaveAttribute(
      "data-expanded",
      "false",
    );
  });

  it("ignores T when single-key shortcuts are off", async () => {
    const user = userEvent.setup();
    render(<Harness shortcuts={false} />);
    await user.keyboard("t");
    expect(screen.getByRole("navigation", { name: "Book contents" })).toHaveAttribute(
      "data-expanded",
      "false",
    );
  });

  it("becomes a sheet on phones", async () => {
    vi.stubGlobal("matchMedia", stubMatchMedia(true));
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("navigation", { name: "Book contents" })).toBeNull();
    await user.keyboard("t");
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByRole("navigation", { name: "Book contents" }),
    ).toBeInTheDocument();
  });
});
