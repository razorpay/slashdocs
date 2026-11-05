import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
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

  it("opens on the prompt and its first output, then types the next command", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage(<LandingPage />);
    const terminal = (await screen.findByText("Your agent")).closest("figure")!;
    expect(terminal).toHaveTextContent(
      /›Write an explainer.*slashdocs●Wrote gps\.html/,
    );

    // Each typed letter sets the timer for the next one.
    for (let i = 0; i < 60; i++)
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    expect(terminal).toHaveTextContent(/\$slashdocs docs create/);
    // The landing page is large to render in jsdom.
  }, 15_000);

  it("shows the last scene once reduced motion turns on, also after the start", async () => {
    const reduce = new Set<() => void>();
    let reduced = false;
    window.matchMedia = (query: string) =>
      ({
        get matches() {
          return query.includes("reduced-motion") && reduced;
        },
        addEventListener: (_: string, listener: () => void) => reduce.add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          reduce.delete(listener),
      }) as unknown as MediaQueryList;
    renderPage(<LandingPage />);
    const team = (await screen.findByText("Your team")).closest("figure")!;
    expect(team).toHaveTextContent("No documents yet");

    reduced = true;
    act(() => reduce.forEach((listener) => listener()));
    expect(team).toHaveTextContent("Added in v2");
    expect(team).not.toHaveTextContent("No documents yet");
  });
});

describe("StartPage", () => {
  it("says in the intro that editors fix the words in place", () => {
    renderPage(<StartPage />);
    expect(screen.getByText(/editors fix the words in place/)).toBeVisible();
  });
});
