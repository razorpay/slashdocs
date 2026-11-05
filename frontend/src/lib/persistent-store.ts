import { useSyncExternalStore } from "react";

// The stores that hold words that the reader typed, and that storage refused:
// their words live only in this tab, and a reload loses them.
const unsaved = new Map<string, () => string[]>();
let unsavedWords: string[] = [];
const unsavedListeners = new Set<() => void>();

function updateUnsaved() {
  const next = [...unsaved.values()].flatMap((words) => words());
  if (next.join("\0") === unsavedWords.join("\0")) return;
  unsavedWords = next;
  unsavedListeners.forEach((listener) => listener());
}

const subscribeUnsaved = (listener: () => void) => {
  unsavedListeners.add(listener);
  return () => void unsavedListeners.delete(listener);
};

// readUnsavedWords gives the words that only this tab holds, and
// useUnsavedWords gives them to a component.
export const readUnsavedWords = () => unsavedWords;
export const useUnsavedWords = () =>
  useSyncExternalStore(subscribeUnsaved, readUnsavedWords);

// createPersistentStore backs a single localStorage key with a subscribable
// store. Updates made anywhere in the app, or in another tab, notify every
// React component reading the value through useStore. A store of the
// reader's words gives `words`, the words that a value holds, so that the
// app can tell when storage refuses them.
export function createPersistentStore<T>(
  key: string,
  initial: T,
  deserialize: (parsed: unknown) => T = (p) => p as T,
  words?: (value: T) => string[],
) {
  const event = `slashdocs:persist:${key}`;

  // Cache the parsed snapshot so useSyncExternalStore sees a stable reference
  // between renders unless the stored string actually changes.
  let cachedRaw: string | null = null;
  let cached: T = initial;

  let memory: string | null = null;

  function read(): T {
    let raw = memory;
    try {
      raw ??= localStorage.getItem(key);
    } catch {
      return initial;
    }
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    if (!raw) {
      cached = initial;
      return cached;
    }
    try {
      cached = deserialize(JSON.parse(raw));
    } catch {
      cached = initial;
    }
    return cached;
  }

  // Storage can be blocked or full. The value then lives in this tab only,
  // so that the app goes on and readers of the store still see it.
  function write(next: T) {
    const raw = JSON.stringify(next);
    try {
      localStorage.setItem(key, raw);
      memory = null;
      unsaved.delete(key);
    } catch {
      memory = raw;
      if (words) unsaved.set(key, () => words(read()).filter((w) => w.trim()));
    }
    if (words) updateUnsaved();
    window.dispatchEvent(new Event(event));
  }

  function subscribe(cb: () => void) {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) cb();
    };
    window.addEventListener(event, cb);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(event, cb);
      window.removeEventListener("storage", onStorage);
    };
  }

  function useStore(): T {
    return useSyncExternalStore(subscribe, read, () => initial);
  }

  return { read, write, useStore };
}
