import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LandingPage } from "./landing";
import { StartPage } from "./start";

// Every observed element is in view, a little, as the top of the agent loop
// is on a phone.
class InViewObserver {
  constructor(private report: IntersectionObserverCallback) {}
  observe(target: Element) {
    const entry = { target, isIntersecting: true, intersectionRatio: 0.1 };
    this.report([entry as IntersectionObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {}
}

function renderPage(page: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no media queries.
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  vi.stubGlobal("IntersectionObserver", InViewObserver);
  vi.spyOn(api, "me").mockRejectedValue(new APIError(401, "unauthorized", "no"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LandingPage", () => {
  it("says that editors fix the words in place", async () => {
    renderPage(<LandingPage />);
    expect(await screen.findByText(/editors fix words in place/)).toBeInTheDocument();
  });

  it("shows the agent's prompt at once, and types it while any of it is in view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<LandingPage />);
    const terminal = (await screen.findByText("Your agent")).closest("figure")!;
    expect(within(terminal).getByText("›")).toBeVisible();

    // Each typed letter sets the timer for the next one.
    for (let i = 0; i < 60; i++)
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    expect(terminal).toHaveTextContent(/›Write an explainer/);
    // The landing page is large to render in jsdom.
  }, 15_000);
});

describe("StartPage", () => {
  it("says in the intro that editors fix the words in place", () => {
    renderPage(<StartPage />);
    expect(screen.getByText(/editors fix the words in place/)).toBeVisible();
  });
});
