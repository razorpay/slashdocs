import { useMemo } from "react";
import {
  DEFAULT_READER_SETTINGS,
  READER_SIZES,
  READER_THEMES,
  READER_WIDTHS,
  type ReaderSettings,
} from "../../bridge/reading";
import { createPersistentStore } from "./persistent-store";

export type StoredReaderSettings = ReaderSettings & { shortcuts: boolean };

const DEFAULTS: StoredReaderSettings = { ...DEFAULT_READER_SETTINGS, shortcuts: true };

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

function deserialize(raw: unknown): StoredReaderSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    size: pick(o.size, READER_SIZES, DEFAULTS.size),
    width: pick(o.width, READER_WIDTHS, DEFAULTS.width),
    theme: pick(o.theme, READER_THEMES, DEFAULTS.theme),
    shortcuts: typeof o.shortcuts === "boolean" ? o.shortcuts : DEFAULTS.shortcuts,
  };
}

// Reader settings are per device (D3).
export const readerSettingsStore = createPersistentStore<StoredReaderSettings>(
  "slashdocs.reader.settings",
  DEFAULTS,
  deserialize,
);

// The settings the frame needs. The object only changes when a setting does,
// so passing it to RenderFrame does not repost settings on every render.
export function useReaderSettings(): ReaderSettings {
  const { size, width, theme } = readerSettingsStore.useStore();
  return useMemo(() => ({ size, width, theme }), [size, width, theme]);
}

const deviceStore = createPersistentStore<string>("slashdocs.reader.device", "", (p) =>
  typeof p === "string" ? p : "",
);

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
let memoryId = "";

function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (n) => ID_CHARS[n % ID_CHARS.length]).join("");
}

// A random id for this browser, made once and kept. If storage is blocked the
// id lasts for the page's life instead of throwing.
export const deviceIdStore = {
  read(): string {
    const saved = deviceStore.read();
    if (saved) return saved;
    if (!memoryId) memoryId = newDeviceId();
    try {
      deviceStore.write(memoryId);
    } catch {
      // Blocked storage: keep the in-memory id.
    }
    return memoryId;
  },
};
