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
