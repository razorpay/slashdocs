const LEGACY_PREFIX = "aidocs";
const PREFIX = "slashdocs";

// migrateLegacyStorage moves preferences and comment drafts saved before the
// rename from aidocs to their slashdocs keys. A value already saved under the
// new key wins. Run it once, before anything reads storage.
export function migrateLegacyStorage(): void {
  try {
    const storage = localStorage;
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(LEGACY_PREFIX)) continue;
      const next = PREFIX + key.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null)
        storage.setItem(next, value);
      storage.removeItem(key);
    }
  } catch {
    // Storage can be blocked. The app then starts with default preferences.
  }
}
