import { useEffect, useRef } from "react";
import { CHORD_WINDOW_MS, isChordBlocked } from "@/lib/esc-chord";

// Single-key reader shortcuts pressed on the host page. Keys pressed inside
// the chapter come from the frame instead (reader.onKey). Nothing fires while
// the reader types, while a dialog or menu is open, when a modifier is held,
// or for the letter that completes an Esc chord (Esc then T is the theme).
export function useReaderKeys(
  keys: readonly string[],
  enabled: boolean,
  onKey: (key: string) => void,
) {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const keyList = keys.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const wanted = new Set(keyList.split("\n"));
    let escapeAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        escapeAt = Date.now();
        return;
      }
      const chord = Date.now() - escapeAt <= CHORD_WINDOW_MS;
      escapeAt = 0;
      if (
        chord ||
        !wanted.has(event.key) ||
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isChordBlocked(event.target) ||
        (event.target instanceof Element && event.target.closest("select"))
      ) {
        return;
      }
      // "/" would otherwise be typed into the search box it opens.
      event.preventDefault();
      onKeyRef.current(event.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, keyList]);
}
