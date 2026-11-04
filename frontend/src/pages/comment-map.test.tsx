import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment } from "@/api";
import { CommentMap } from "./comment-map";
import { DocProvider, type DocContextValue } from "./doc-context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const comment = (id: string, quote: string) =>
  ({ id, selected_text: quote, status: "open" }) as Comment;
const comments = [comment("late", "closing remarks"), comment("early", "opening line")];
const positions = new Map([
  ["late", { top: 1000, bottom: 1020 }],
  ["early", { top: 200, bottom: 220 }],
]);

// jsdom has no layout, so give the strip a viewport height to measure.
const stripHeight = (px: number) =>
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(px);

// The ticks are pointer-first (tabindex -1), so find them regardless of focusability.
const ticks = () => screen.getAllByRole("button", { hidden: true });
const tick = (name: RegExp) => screen.getByRole("button", { name, hidden: true });

function renderMap(overrides: Partial<DocContextValue> = {}, list = comments) {
  const doc = {
    commentPositions: positions,
    documentHeight: 1000,
    activeComment: undefined,
    setActiveComment: vi.fn(),
    scrollDocumentTo: vi.fn(),
    ...overrides,
  } as unknown as DocContextValue;
  render(
    <DocProvider value={doc}>
      <CommentMap comments={list} />
    </DocProvider>,
  );
  return doc;
}

it("offers one labelled jump button per positioned thread, in document order", () => {
  renderMap();

  expect(ticks().map((t) => t.getAttribute("aria-label"))).toEqual([
    "Comment 1 of 2: opening line",
    "Comment 2 of 2: closing remarks",
  ]);
});

it("places each tick at its share of the document", () => {
  renderMap();

  expect(ticks().map((t) => t.style.top)).toEqual(["20%", "100%"]);
});

it("leaves the ticks out of the tab order, since the comments list reaches every thread", () => {
  renderMap();

  for (const t of ticks()) expect(t).toHaveAttribute("tabindex", "-1");
});

it("marks the active thread", () => {
  renderMap({ activeComment: "early" });

  expect(tick(/opening line/)).toHaveAttribute("aria-current", "true");
  expect(tick(/closing remarks/)).not.toHaveAttribute("aria-current");
});

it("labels a thread without a quote by its position alone", () => {
  renderMap({}, [comment("early", "")]);

  expect(ticks()[0]).toHaveAccessibleName("Comment 1 of 1");
});

it("activates a thread when its tick is clicked", async () => {
  const doc = renderMap();

  await userEvent.click(tick(/closing remarks/));

  expect(doc.setActiveComment).toHaveBeenCalledWith("late");
  expect(doc.scrollDocumentTo).not.toHaveBeenCalled();
});

it("scrolls to a thread that is already active, since activating it again would not", async () => {
  stripHeight(500);
  const doc = renderMap({ activeComment: "late" });

  await userEvent.click(tick(/closing remarks/));

  // The thread's top, less a third of the viewport so it lands above centre.
  expect(doc.scrollDocumentTo).toHaveBeenCalledWith(1000 - 500 / 3);
  expect(doc.setActiveComment).not.toHaveBeenCalled();
});

it("renders nothing when the document fits on one screen", () => {
  stripHeight(500);
  renderMap({ documentHeight: 450 });

  expect(screen.queryByRole("button", { hidden: true })).not.toBeInTheDocument();
});
