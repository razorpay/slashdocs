import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Principal } from "@/api";
import { DocProvider, type DocContextValue } from "./doc-context";
import { UpdateBanner, type DocUpdate } from "./doc-update-banner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const asha: Principal = { type: "user", id: "asha", name: "Asha" };
const ravi: Principal = { type: "user", id: "ravi", name: "Ravi" };
const bot: Principal = { type: "service_account", id: "sa_docs" };

function renderBanner(update?: DocUpdate) {
  const doc = { showUpdate: vi.fn(), principal: ravi };
  const view = render(
    <DocProvider value={doc as unknown as DocContextValue}>
      <UpdateBanner update={update} />
    </DocProvider>,
  );
  return { banner: screen.getByRole("status"), ...doc, ...view };
}

it("says who updated the document, and nothing about how much", () => {
  expect(renderBanner({ authors: [asha] }).banner).toHaveTextContent(
    /^Asha updated this document\.Show the latest$/,
  );
});

it("names every author, and a service account by its id", () => {
  expect(renderBanner({ authors: [asha, ravi, bot] }).banner).toHaveTextContent(
    /^Asha, Ravi, and sa_docs updated this document\./,
  );
});

it("says that the reader updated the document when they are its only author, as with a push from their own terminal", () => {
  expect(renderBanner({ authors: [ravi] }).banner).toHaveTextContent(
    /^You updated this document\.Show/,
  );
});

it("says that the document changed when it does not know who changed it", () => {
  expect(renderBanner().banner).toHaveTextContent(/^This document changed\.Show/);
  cleanup();
  expect(renderBanner({ authors: [] }).banner).toHaveTextContent(
    /^This document changed\.Show/,
  );
});

it("shows the change that waits when the reader asks", () => {
  const { showUpdate } = renderBanner({ authors: [asha] });
  fireEvent.click(screen.getByRole("button", { name: "Show the latest" }));
  expect(showUpdate).toHaveBeenCalledOnce();
});

it("is in the layout above the document, and covers none of it", () => {
  const { banner } = renderBanner({ authors: [asha] });
  expect(banner).toHaveClass("border-b", "bg-[var(--color-accent-muted)]");
  expect(banner).not.toHaveClass("absolute");
});
