import * as React from "react";
import {
  CHORD_RESOLVED_MS,
  CHORD_WINDOW_MS,
  IDLE,
  isChordBlocked,
  isInLayer,
  reduceChord,
  type ChordEffect,
  type ChordEvent,
  type ChordKey,
  type ChordState,
} from "./esc-chord";

export function useEscChord({
  available,
  onRun,
  onEscape,
  takeEscape = () => false,
  enabled = true,
}: {
  available: ReadonlyArray<ChordKey>;
  onRun: (key: ChordKey) => void;
  onEscape: () => void;
  // Something on screen that an Esc closes, as an open thread, takes it at
  // once and says so.
  takeEscape?: () => boolean;
  enabled?: boolean;
}): ChordState {
  const [state, setState] = React.useState<ChordState>(IDLE);
  const stateRef = React.useRef<ChordState>(IDLE);
  const availableRef = React.useRef(available);
  availableRef.current = available;
  const onRunRef = React.useRef(onRun);
  onRunRef.current = onRun;
  const onEscapeRef = React.useRef(onEscape);
  onEscapeRef.current = onEscape;
  const takeEscapeRef = React.useRef(takeEscape);
  takeEscapeRef.current = takeEscape;
  const timerRef = React.useRef<number>(undefined);

  const dispatch = React.useCallback((event: ChordEvent): ChordEffect => {
    const { state: next, effect } = reduceChord(
      stateRef.current,
      event,
      availableRef.current,
    );
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (next.phase === "armed") {
      timerRef.current = window.setTimeout(
        () => dispatch({ type: "expire" }),
        CHORD_WINDOW_MS,
      );
    } else if (next.phase === "resolved") {
      timerRef.current = window.setTimeout(
        () => dispatch({ type: "clear" }),
        CHORD_RESOLVED_MS,
      );
    }
    if (effect?.type === "run") onRunRef.current(effect.key);
    if (effect?.type === "escape") onEscapeRef.current();
    return effect;
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      dispatch({ type: "cancel" });
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Only an Esc that nothing else uses arms the chord. What takes the Esc
      // keeps it, so that the Esc does nothing more, as stop a follow.
      const blocked = isChordBlocked(event.target);
      const escape = event.key === "Escape";
      const used = () => event.defaultPrevented || isInLayer(event.target);
      if (escape && !blocked && !used() && takeEscapeRef.current())
        event.preventDefault();
      if (blocked || (escape && used())) {
        dispatch({ type: "cancel" });
        return;
      }
      const effect = dispatch({
        type: "keydown",
        key: event.key,
        modified: event.metaKey || event.ctrlKey || event.altKey,
      });
      // The letter of a chord is the chord's alone: C opens the comments,
      // and does not also place a pin.
      if (effect?.type === "run") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(timerRef.current);
    };
  }, [enabled, dispatch]);

  return state;
}
