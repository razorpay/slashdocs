import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextEditBox } from "./doc-text-edit-box";

afterEach(cleanup);

function setup(seed: string, dropped = false) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <TextEditBox
      seed={seed}
      dropped={dropped}
      position={{ left: 0, top: 0 }}
      onApply={onApply}
      onCancel={onCancel}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Edited text" });
  return { onApply, onCancel, editor, user: userEvent.setup() };
}

function select(editor: HTMLElement, text: string) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  throw new Error(`no ${text}`);
}

describe("TextEditBox", () => {
  it("applies bold, italic, and code to the selection", async () => {
    const { editor, onApply, user } = setup("one two three");
    select(editor, "one");
    await user.click(screen.getByRole("button", { name: "Bold" }));
    select(editor, "two");
    await user.click(screen.getByRole("button", { name: "Italic" }));
    select(editor, "three");
    await user.click(screen.getByRole("button", { name: "Code" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(
      "<strong>one</strong> <em>two</em> <code>three</code>",
    );
  });

  it("wraps a selection that ends inside bold without leaving an empty element", async () => {
    const { editor, onApply, user } = setup("starts on <strong>Monday</strong>");
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.setEnd(editor.querySelector("strong")!.firstChild!, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await user.click(screen.getByRole("button", { name: "Italic" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith("<em>starts on <strong>Monday</strong></em>");
  });

  it("removes bold from text that is already bold", async () => {
    const { editor, onApply, user } = setup("a <b>bold</b> word");
    select(editor, "bold");
    await user.click(screen.getByRole("button", { name: "Bold" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith("a bold word");
  });

  it("links the selection to a web address", async () => {
    const { editor, onApply, user } = setup("see the docs");
    select(editor, "docs");
    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.type(
      screen.getByRole("textbox", { name: "Link address" }),
      "x.test{Enter}",
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith('see the <a href="https://x.test">docs</a>');
  });

  it("warns when the original styling will be removed", () => {
    setup("styled text", true);
    expect(screen.getByRole("status")).toHaveTextContent(/styling .* will be removed/i);
  });

  it("cancels with Escape", async () => {
    const { editor, onCancel, user } = setup("text");
    editor.focus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
