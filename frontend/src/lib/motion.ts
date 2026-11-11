import type { MotionProps } from "framer-motion";

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

// A control that comes and goes in the bar, as Show changes, rises a little
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

// The content of a popover gives way to the next thread's, as J and K go to
// it.
export const crossFade: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.12, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: "easeIn" } },
};

// One label gives way to another in the same place.
export const swap: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: "easeIn" } },
};
