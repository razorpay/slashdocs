import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal, Version } from "@/api";
import { HistoryDialog } from "./doc-history";

const ana: Principal = { type: "user", id: "ana", name: "Ana" };
const versions: Version[] = [1, 2].map((number) => ({
  id: `ver_${number}`,
  number,
  created_by: ana,
  created_at: new Date(Date.UTC(2026, 9, 1, 10, number)).toISOString(),
}));

function renderHistory(current: string) {
  render(
    <HistoryDialog
      open
      onOpenChange={() => {}}
      current={current}
      latest="ver_2"
      versions={versions}
      onSelectVersion={() => {}}
    />,
  );
  return screen.getByRole("dialog");
}

afterEach(cleanup);

describe("HistoryDialog", () => {
  it("marks only the current entry when the document is not a preview", () => {
    const dialog = renderHistory("ver_2");
    expect(within(dialog).getByText("Current")).toBeVisible();
    expect(within(dialog).queryByText("Viewing")).toBeNull();
    // The session counts its earlier entries once, on the expander.
    expect(within(dialog).queryByText(/edits since/)).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Show 1 earlier edit" }),
    ).toBeVisible();
  });

  it("marks the entry that the preview shows", () => {
    const dialog = renderHistory("ver_1");
    expect(within(dialog).getByText("Viewing", { exact: false })).toBeInTheDocument();
  });
});
