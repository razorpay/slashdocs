import { useSyncExternalStore, type CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "@/lib/theme";

// Toasts follow the app's theme and use its surface colors. They show at the
// bottom center, above any sheet at the bottom of the screen. The top keeps
// what the reader works on: the heading under the bar, the hint of a pin
// placement, and an open thread beside its words. The document says what
// happens to it in the doc bar or at its own controls, not in a toast.
const tokens = {
  "--normal-bg": "var(--color-surface)",
  "--normal-border": "var(--color-border)",
  "--normal-text": "var(--color-fg)",
  "--border-radius": "var(--radius-sm)",
} as CSSProperties;
const GAP = 16;

// The height of each sheet at the bottom of the screen.
const sheets = new Map<object, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const tallest = () => Math.max(0, ...sheets.values());
function setSheet(key: object, height: number) {
  if (height) sheets.set(key, height);
  else sheets.delete(key);
  listeners.forEach((listener) => listener());
}

// keepToastsAbove, as the ref of an element, keeps toasts above it while it
// sits at the bottom of the screen, as a sheet on a narrow screen does.
export function keepToastsAbove(el: HTMLElement | null) {
  if (!el) return;
  const key = {};
  // The layout box, without the transform of an enter or an exit.
  const measure = () =>
    setSheet(key, parseFloat(getComputedStyle(el).bottom) < 1 ? el.offsetHeight : 0);
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  return () => {
    observer.disconnect();
    setSheet(key, 0);
  };
}

export function Toaster() {
  const sheet = useSyncExternalStore(subscribe, tallest);
  return (
    <Sonner
      theme={useResolvedTheme()}
      position="bottom-center"
      offset={{ bottom: GAP + sheet }}
      mobileOffset={{ bottom: GAP + sheet }}
      style={tokens}
    />
  );
}
