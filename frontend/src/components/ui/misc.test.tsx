import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    // The help stays until the next try, so that the reader can copy by hand.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
  });

  it("fades only the sides that hide text, as the command scrolls", () => {
    render(
      <CodeBlock copy={false}>
        curl -fsSL https://docs.example.com/install.sh | sh
      </CodeBlock>,
    );
    const pre = screen.getByText(/install\.sh/);
    const scrollTo = (scrollLeft: number, scrollWidth = 399) => {
      Object.assign(pre, { scrollLeft });
      Object.defineProperties(pre, {
        scrollWidth: { value: scrollWidth, configurable: true },
        clientWidth: { value: 274, configurable: true },
      });
      fireEvent.scroll(pre);
    };

    expect(pre.style.maskImage).toBe("");
    scrollTo(0);
    expect(pre.style.maskImage).toMatch(
      /^linear-gradient\(to right, black, black calc/,
    );
    scrollTo(60);
    expect(pre.style.maskImage).toMatch(/transparent, black 1\.5rem, black calc/);
    scrollTo(125);
    expect(pre.style.maskImage).toBe(
      "linear-gradient(to right, transparent, black 1.5rem, black)",
    );
    scrollTo(0, 274);
    expect(pre.style.maskImage).toBe("");
  });
});
