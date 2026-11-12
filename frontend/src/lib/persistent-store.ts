import { useSyncExternalStore } from "react";

// createPersistentStore backs a single localStorage key with a subscribable
// store. Updates made anywhere in the app, or in another tab, notify every
// React component reading the value through useStore.
export function createPersistentStore<T>(
  key: string,
  initial: T,
  deserialize: (parsed: unknown) => T = (p) => p as T,
) {
  const event = `slashdocs:persist:${key}`;

  // Cache the parsed snapshot so useSyncExternalStore sees a stable reference
  // between renders unless the stored string actually changes.
  let cachedRaw: string | null = null;
  let cached: T = initial;

  function read(): T {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
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

  function write(next: T) {
    localStorage.setItem(key, JSON.stringify(next));
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
