import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearOneTimeKeys, keepOneTimeKey } from "@/lib/one-time-keys";
import { OneTimeKeyDialog } from "./one-time-key-dialog";

afterEach(() => {
  cleanup();
  clearOneTimeKeys();
});

const TOKEN = "slashdocs_sa_oTQbrRIQeVwmy6VzPouVggajtHrV8ZxV0Q8GAXnz";

async function showKey() {
  render(
    <TooltipProvider>
      <OneTimeKeyDialog />
    </TooltipProvider>,
  );
  await act(() =>
    keepOneTimeKey(Promise.resolve(TOKEN), (token) => ({ bot: "n8n@ops.bot", token })),
  );
  return screen.findByRole("dialog");
}

const tokenBlock = (dialog: HTMLElement) =>
  within(dialog).getByText(TOKEN).parentElement!;

it("shows the whole key with a Copy button that needs no hover", async () => {
  const dialog = await showKey();
  expect(within(dialog).getByText(TOKEN)).toHaveClass("whitespace-pre-wrap");
  const copy = within(tokenBlock(dialog)).getByRole("button", { name: "Copy" });
  expect(copy.className).not.toContain("opacity-0");
});

it("asks before it closes a key that the reader did not copy", async () => {
  const user = userEvent.setup();
  const dialog = await showKey();
  await user.keyboard("{Escape}");
  expect(within(dialog).getByRole("alert")).toHaveTextContent(/Close without a copy\?/);
  await user.click(within(dialog).getByRole("button", { name: "Keep it open" }));
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Close without a copy" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("closes on Done after a copy, and warns before a reload until then", async () => {
  const user = userEvent.setup();
  const dialog = await showKey();
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(unload()).toBe(true);
  await user.click(within(tokenBlock(dialog)).getByRole("button", { name: "Copy" }));
  await expect(navigator.clipboard.readText()).resolves.toBe(TOKEN);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(unload()).toBe(false);
});

it("says how to copy by hand when the browser refuses", async () => {
  const user = userEvent.setup();
  const dialog = await showKey();
  navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
  await user.click(within(tokenBlock(dialog)).getByRole("button", { name: "Copy" }));
  expect(
    await within(dialog).findByText(/Could not copy. The text is selected/),
  ).toBeVisible();
  expect(window.getSelection()?.toString()).toBe(TOKEN);
});
