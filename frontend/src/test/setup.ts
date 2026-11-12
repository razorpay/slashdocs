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

// jsdom has no Web Locks. A lock here is exclusive: a request waits while
// another holds it, and one with ifAvailable gets null then.
const held = new Map<string, Promise<unknown>>();
Object.defineProperty(navigator, "locks", {
  value: {
    request(
      name: string,
      ...args:
        [LockGrantedCallback<unknown>] | [LockOptions, LockGrantedCallback<unknown>]
    ) {
      const [options, work] = args.length === 1 ? [{}, args[0]] : args;
      const before = held.get(name);
      if (before && options.ifAvailable) return Promise.resolve(work(null));
      const run = Promise.resolve(before)
        .catch(() => {})
        .then(() => work({ name, mode: "exclusive" }));
      const done = run.then(
        () => {},
        () => {},
      );
      held.set(name, done);
      void done.then(() => held.get(name) === done && held.delete(name));
      return run;
    },
  },
});
