import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Principal } from "@/api";
import { UpdateBanner, type DocUpdate } from "./doc-update-banner";

afterEach(cleanup);

const asha: Principal = { type: "user", id: "asha", name: "Asha" };
const ravi: Principal = { type: "user", id: "ravi", name: "Ravi" };
const bot: Principal = { type: "service_account", id: "sa_docs" };

function renderBanner(update?: DocUpdate, floating = false) {
  const onShowLatest = vi.fn();
  render(
    <UpdateBanner update={update} onShowLatest={onShowLatest} floating={floating} />,
  );
  return { banner: screen.getByRole("status"), onShowLatest };
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

it("says that the document changed when it does not know who changed it", () => {
  expect(renderBanner().banner).toHaveTextContent(/^This document changed\.Show/);
  cleanup();
  expect(renderBanner({ authors: [] }).banner).toHaveTextContent(
    /^This document changed\.Show/,
  );
});

it("shows the latest when the reader asks", () => {
  const { onShowLatest } = renderBanner({ authors: [asha] });
  fireEvent.click(screen.getByRole("button", { name: "Show the latest" }));
  expect(onShowLatest).toHaveBeenCalledOnce();
});

it("is a bar across the top of the document, and floats in full screen", () => {
  expect(renderBanner({ authors: [asha] }).banner).toHaveClass(
    "border-b",
    "bg-[var(--color-accent-muted)]",
  );
  cleanup();
  expect(renderBanner({ authors: [asha] }, true).banner).toHaveClass(
    "absolute",
    "shadow-xl",
  );
});
