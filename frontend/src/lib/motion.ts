import type { MotionProps, TargetAndTransition } from "framer-motion";

// The motion of the floating panels that React mounts and unmounts. They
// match the CSS of the Radix dialogs, sheets and menus in styles.css: a
// short ease-out enter and a faster exit.
const SHEET_EASE = [0.32, 0.72, 0, 1] as const;

// A popover grows from its anchor.
export const popIn: MotionProps = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.15, ease: "easeOut" } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: "easeIn" } },
};

// A panel beside the document slides in from its edge.
export const slideIn: MotionProps = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, x: 8, transition: { duration: 0.12, ease: "easeIn" } },
};

// A sheet at the bottom of a narrow screen rises from the edge.
export const sheetUp: MotionProps = {
  initial: { y: "100%" },
  animate: { y: 0, transition: { duration: 0.3, ease: SHEET_EASE } },
  exit: { y: "100%", transition: { duration: 0.2, ease: SHEET_EASE } },
};

// The backdrop under a sheet.
export const fade: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: "easeIn" } },
};

// A control that comes and goes in the bar, as Stop following, rises a little
// into place, and sinks back faster.
export const rise: MotionProps = {
  initial: { opacity: 0, y: 4, scale: 0.96 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.15, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    y: 4,
    scale: 0.96,
    transition: { duration: 0.1, ease: "easeIn" },
  },
};

// A reader who asks for less motion gets no scale or travel, which
// MotionConfig takes away, and fades of at most 100 ms, which this gives.
const fadeFor = (seconds: number, reduced: boolean | null) =>
  reduced ? Math.min(seconds, 0.1) : seconds;

// The content of a popover gives way to the next thread's, as J and K go to
// it: the new content fades in over the old, which goes at once, so that the
// popover never holds two threads.
export const fadeIn = (reduced: boolean | null): MotionProps => ({
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: fadeFor(0.12, reduced), ease: "easeOut" },
  },
});

// The popover of a thread that the reader resolved shrinks a little as it
// fades.
export const resolvedOut = (reduced: boolean | null): TargetAndTransition => ({
  opacity: 0,
  scale: 0.96,
  transition: { duration: fadeFor(0.15, reduced), ease: "easeIn" },
});

// A row that leaves a list fades, and the rows under it close up.
export const rowOut = (reduced: boolean | null): MotionProps => ({
  exit: {
    opacity: 0,
    transition: { duration: fadeFor(0.18, reduced), ease: "easeIn" },
  },
  transition: { layout: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } },
});

// A new label fades in where the old one was. The old one goes at once, so
// that two labels never show together in a control that changes its size.
export const swap: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
};
