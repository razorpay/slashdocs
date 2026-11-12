import { describe, expect, it } from "vitest";
import {
  CHORD_KEYS,
  IDLE,
  chordKeyFromEvent,
  isChordBlocked,
  reduceChord,
  type ChordKey,
  type ChordState,
} from "./esc-chord";

const ALL: ChordKey[] = ["t", "f", "c", "m", "h"];

function press(state: ChordState, key: string, available: ChordKey[] = ALL) {
  return reduceChord(state, { type: "keydown", key }, available);
}

function armed(available: ChordKey[] = ALL) {
  return press(IDLE, "Escape", available).state;
}

describe("reduceChord", () => {
  it("arms on Escape without running anything", () => {
    expect(press(IDLE, "Escape")).toEqual({
      state: { phase: "armed" },
      effect: null,
    });
  });

  it("ignores ordinary keys while idle", () => {
    expect(press(IDLE, "t")).toEqual({ state: IDLE, effect: null });
  });

  it.each(ALL)("resolves Escape then %s", (key) => {
    expect(press(armed(), key)).toEqual({
      state: { phase: "resolved", key },
      effect: { type: "run", key },
    });
  });

  it("accepts an uppercase chord key", () => {
    expect(press(armed(), "T").effect).toEqual({ type: "run", key: "t" });
  });

  it("cancels silently on unavailable or unmapped keys", () => {
    expect(press(armed(["t", "f", "h"]), "c", ["t", "f", "h"])).toEqual({
      state: IDLE,
      effect: null,
    });
    expect(press(armed(), "q")).toEqual({ state: IDLE, effect: null });
  });

  it("falls through to ordinary Escape when the window expires", () => {
    expect(reduceChord(armed(), { type: "expire" }, ALL)).toEqual({
      state: IDLE,
      effect: { type: "escape" },
    });
  });

  it("fires ordinary Escape immediately for Escape Escape", () => {
    expect(press(armed(), "Escape")).toEqual({
      state: IDLE,
      effect: { type: "escape" },
    });
  });

  it("clears a resolved keycast and ignores stale expiry", () => {
    const resolved = press(armed(), "t").state;
    expect(reduceChord(resolved, { type: "expire" }, ALL).state).toEqual(resolved);
    expect(reduceChord(resolved, { type: "clear" }, ALL)).toEqual({
      state: IDLE,
      effect: null,
    });
  });

  it("re-arms while the resolved keycast is still visible", () => {
    expect(press(press(armed(), "t").state, "Escape").state).toEqual({
      phase: "armed",
    });
  });

  it("cancels a pending chord without an effect", () => {
    expect(reduceChord(armed(), { type: "cancel" }, ALL)).toEqual({
      state: IDLE,
      effect: null,
    });
    expect(reduceChord(IDLE, { type: "cancel" }, ALL).state).toBe(IDLE);
  });

  it("rejects modified Escape and chord keys", () => {
    expect(
      reduceChord(IDLE, { type: "keydown", key: "Escape", modified: true }, ALL),
    ).toEqual({ state: IDLE, effect: null });
    expect(
      reduceChord(armed(), { type: "keydown", key: "t", modified: true }, ALL),
    ).toEqual({ state: IDLE, effect: null });
  });

  it("exposes the requested display order", () => {
    expect(CHORD_KEYS.map((item) => item.key)).toEqual(ALL);
  });
});

describe("chordKeyFromEvent", () => {
  it("maps only configured keys", () => {
    expect(chordKeyFromEvent("f")).toBe("f");
    expect(chordKeyFromEvent("H")).toBe("h");
    expect(chordKeyFromEvent("Escape")).toBeNull();
    expect(chordKeyFromEvent("z")).toBeNull();
  });
});

describe("isChordBlocked", () => {
  function withDOM(html: string, run: () => void) {
    document.body.innerHTML = html;
    try {
      run();
    } finally {
      document.body.innerHTML = "";
    }
  }

  it("allows a plain document", () => {
    withDOM("<p>hello</p>", () => {
      expect(isChordBlocked(document.querySelector("p"))).toBe(false);
    });
  });

  it("blocks text inputs, textareas, and contenteditable regions", () => {
    withDOM(
      '<input><textarea></textarea><div contenteditable="true"><b>x</b></div>',
      () => {
        expect(isChordBlocked(document.querySelector("input"))).toBe(true);
        expect(isChordBlocked(document.querySelector("textarea"))).toBe(true);
        expect(isChordBlocked(document.querySelector("b"))).toBe(true);
      },
    );
  });

  it("does not block non-text inputs", () => {
    withDOM('<input type="checkbox">', () => {
      expect(isChordBlocked(document.querySelector("input"))).toBe(false);
    });
  });

  it("blocks open Radix dialogs and menus, but not closed ones", () => {
    withDOM('<div role="dialog" data-state="open"></div>', () => {
      expect(isChordBlocked(document.body)).toBe(true);
    });
    withDOM('<div role="menu" data-state="open"></div>', () => {
      expect(isChordBlocked(document.body)).toBe(true);
    });
    withDOM('<div role="dialog" data-state="closed"></div>', () => {
      expect(isChordBlocked(document.body)).toBe(false);
    });
  });
});
