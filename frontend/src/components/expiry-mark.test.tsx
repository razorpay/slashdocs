import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatTimestamp } from "@/lib/format-date";
import { ExpiryMark } from "./expiry-mark";

afterEach(cleanup);

const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const mark = (props: Parameters<typeof ExpiryMark>[0]) =>
  render(
    <TooltipProvider>
      <ExpiryMark {...props} />
    </TooltipProvider>,
  );

describe("ExpiryMark", () => {
  it("says when the document is deleted", () => {
    mark({ expiresAt: at(3 * 24 * HOUR) });
    expect(screen.getByText("Deletes in 3 days")).toBeVisible();
  });

  it("says soon when the time passed", () => {
    mark({ expiresAt: at(-HOUR) });
    expect(screen.getByText("Deletes soon")).toBeVisible();
  });

  it("is short in a list", () => {
    mark({ expiresAt: at(3 * 24 * HOUR), compact: true });
    expect(screen.getByText("3 days")).toBeVisible();
    expect(screen.queryByText(/Deletes/)).toBeNull();
  });

  it("names the full sentence and the exact time, also when short", () => {
    const expiresAt = at(5 * HOUR);
    mark({ expiresAt, compact: true });
    const name = screen.getByRole("img").getAttribute("aria-label");
    expect(name).toContain("Deletes in 5 hours");
    expect(name).toContain(
      `This document is deleted on ${formatTimestamp(expiresAt)}.`,
    );
  });

  it("is muted, until less than a day remains", () => {
    mark({ expiresAt: at(2 * 24 * HOUR) });
    expect(screen.getByRole("img").className).toContain("--color-fg-muted");
    expect(screen.getByRole("img").className).not.toContain("--color-warning");
    cleanup();
    mark({ expiresAt: at(23 * HOUR) });
    expect(screen.getByRole("img").className).toContain("--color-warning");
    expect(screen.getByRole("img").className).not.toContain("--color-fg-muted");
  });

  it("has the warning color when the time passed", () => {
    mark({ expiresAt: at(-HOUR) });
    expect(screen.getByRole("img").className).toContain("--color-warning");
  });

  it("is the icon alone when it has no room, and keeps its name and its color", () => {
    const expiresAt = at(5 * HOUR);
    mark({ expiresAt, iconOnly: true });
    const icon = screen.getByRole("img");
    expect(icon).toHaveTextContent("");
    expect(icon.getAttribute("aria-label")).toContain("Deletes in 5 hours");
    expect(icon.getAttribute("aria-label")).toContain(
      `This document is deleted on ${formatTimestamp(expiresAt)}.`,
    );
    expect(icon.className).toContain("--color-warning");
  });

  it("is an icon button for the owner, which opens the dialog", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    mark({ expiresAt: at(3 * 24 * HOUR), iconOnly: true, onOpen });
    const button = screen.getByRole("button", { name: /Deletes in 3 days/ });
    expect(button).toHaveTextContent("");
    expect(button.className).toContain("size-8");
    await user.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("is nothing without a time", () => {
    const { container } = mark({ expiresAt: undefined });
    expect(container).toBeEmptyDOMElement();
    cleanup();
    expect(mark({ expiresAt: "" }).container).toBeEmptyDOMElement();
  });
});
