import { act, cleanup, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { clearCommentDrafts, saveReplyDraft } from "@/lib/comment-drafts";
import { UnsavedWords } from "./unsaved-words";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearCommentDrafts();
});

it("warns, offers a copy and guards a reload while storage refuses a reply", async () => {
  const warning = vi.spyOn(toast, "warning");
  const dismiss = vi.spyOn(toast, "dismiss");
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<UnsavedWords />);

  act(() => saveReplyDraft("doc_1", "c_1", { body: "My reply", mentions: [] }));
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("They stay in this tab only, and a reload loses them."),
    expect.objectContaining({ duration: Infinity }),
  );
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const { action } = warning.mock.lastCall![1] as unknown as {
    action: { onClick: (e: { preventDefault(): void }) => void };
  };
  await act(async () => action.onClick({ preventDefault() {} }));
  expect(writeText).toHaveBeenCalledWith("My reply");

  setItem.mockRestore();
  act(() => saveReplyDraft("doc_1", "c_1", { body: "My reply", mentions: [] }));
  expect(dismiss).toHaveBeenCalledWith("unsaved-words");
  vi.unstubAllGlobals();
});
