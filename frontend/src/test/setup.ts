import "@testing-library/jest-dom/vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserverStub,
  writable: true,
});

Object.defineProperty(Element.prototype, "hasPointerCapture", {
  value: () => false,
});
Object.defineProperty(Element.prototype, "setPointerCapture", {
  value: () => undefined,
});
Object.defineProperty(Element.prototype, "releasePointerCapture", {
  value: () => undefined,
});

// jsdom has no media queries. None matches, as on a narrow screen, unless a
// test sets its own.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList;
