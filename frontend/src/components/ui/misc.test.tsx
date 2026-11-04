import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./tooltip";
import { CodeBlock } from "./misc";

describe("CodeBlock", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("says when it could not copy, and selects the text to copy by hand", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(
      <TooltipProvider>
        <CodeBlock>slashdocs docs create report.html</CodeBlock>
      </TooltipProvider>,
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(screen.getByRole("button", { name: "Could not copy" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
    expect(window.getSelection()?.toString()).toBe("slashdocs docs create report.html");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
