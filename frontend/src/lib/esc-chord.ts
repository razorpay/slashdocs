// Esc-leader keyboard chords for the document viewer. Timing and effects live
// in use-esc-chord.ts so this state machine remains deterministic and testable.

export const CHORD_WINDOW_MS = 800;
export const CHORD_RESOLVED_MS = 600;

export type ChordKey = "t" | "f" | "c" | "m" | "h";

export const CHORD_KEYS: ReadonlyArray<{ key: ChordKey; hint: string }> = [
  { key: "t", hint: "theme" },
  { key: "f", hint: "full screen" },
  { key: "c", hint: "comments" },
  { key: "m", hint: "cursors" },
  { key: "h", hint: "home" },
];

const KEYS: ReadonlySet<string> = new Set(CHORD_KEYS.map((item) => item.key));

export type ChordState =
  { phase: "idle" } | { phase: "armed" } | { phase: "resolved"; key: ChordKey };

export const IDLE: ChordState = { phase: "idle" };

export type ChordEvent =
  | { type: "keydown"; key: string; modified?: boolean }
  | { type: "expire" }
  | { type: "clear" }
  | { type: "cancel" };

export type ChordEffect = { type: "run"; key: ChordKey } | { type: "escape" } | null;

export function chordKeyFromEvent(key: string): ChordKey | null {
  const lower = key.toLowerCase();
  return KEYS.has(lower) ? (lower as ChordKey) : null;
}

export function reduceChord(
  state: ChordState,
  event: ChordEvent,
  available: ReadonlyArray<ChordKey>,
): { state: ChordState; effect: ChordEffect } {
  if (event.type === "cancel") {
    return { state: state.phase === "idle" ? state : IDLE, effect: null };
  }
  if (event.type === "clear") {
    return { state: state.phase === "resolved" ? IDLE : state, effect: null };
  }
  if (event.type === "expire") {
    if (state.phase !== "armed") return { state, effect: null };
    return { state: IDLE, effect: { type: "escape" } };
  }

  const armed = state.phase === "armed";
  if (event.modified) {
    return { state: armed ? IDLE : state, effect: null };
  }
  if (event.key === "Escape") {
    if (armed) return { state: IDLE, effect: { type: "escape" } };
    return { state: { phase: "armed" }, effect: null };
  }
  if (!armed) return { state, effect: null };

  const key = chordKeyFromEvent(event.key);
  if (!key || !available.includes(key)) return { state: IDLE, effect: null };
  return { state: { phase: "resolved", key }, effect: { type: "run", key } };
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

export function isChordBlocked(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (el) {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (TEXT_INPUT_TYPES.has(type)) return true;
    }
    if (el.closest('[contenteditable="true"], [contenteditable=""]')) return true;
  }
  const doc = el?.ownerDocument || globalThis.document;
  return !!doc?.querySelector(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
}
