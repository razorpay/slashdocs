import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocProvider, type DocContextValue } from "./doc-context";
import { ShortcutsDialog } from "./doc-shortcuts";

function renderShortcuts(editable: boolean) {
  render(
    <DocProvider value={{ editable } as unknown as DocContextValue}>
      <ShortcutsDialog open onOpenChange={() => {}} />
    </DocProvider>,
  );
  return screen.getByRole("dialog");
}

// The keys that a row shows, one entry per kbd.
const keysOf = (dialog: HTMLElement, label: string) =>
  [...within(dialog).getByText(label).parentElement!.querySelectorAll("kbd")].map(
    (kbd) => kbd.textContent,
  );

afterEach(cleanup);

describe("ShortcutsDialog", () => {
  it("lists the editing keys for an editor, as the comment chip names keys", () => {
    const dialog = renderShortcuts(true);
    expect(within(dialog).getByText("Editing")).toBeVisible();
    expect(keysOf(dialog, "Bold")).toEqual(["Ctrl+B"]);
    expect(keysOf(dialog, "Redo")).toEqual(["Ctrl+Shift+Z"]);
    expect(keysOf(dialog, "Line break")).toEqual(["Shift+Enter"]);
    expect(keysOf(dialog, "Comment on the text you edit")).toEqual(["Ctrl+Alt+M"]);
    // Keys in turn keep a kbd each.
    expect(keysOf(dialog, "Top")).toEqual(["G", "G"]);
  });

  it("leaves the editing keys out for a reader who cannot edit", () => {
    const dialog = renderShortcuts(false);
    expect(within(dialog).queryByText("Editing")).toBeNull();
    expect(within(dialog).queryByText("Bold")).toBeNull();
  });
});
