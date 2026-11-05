import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "@/lib/theme";

// Toasts follow the app's theme and use its surface colors. On every screen
// they show at the top center, below the 56px bar, where the document shows
// its own hints. A comment thread sits beside its words, and a comment sheet
// at the bottom, so a toast covers neither.
const tokens = {
  "--normal-bg": "var(--color-surface)",
  "--normal-border": "var(--color-border)",
  "--normal-text": "var(--color-fg)",
  "--border-radius": "var(--radius-sm)",
} as CSSProperties;
const BELOW_BAR = { top: 64 };

export function Toaster() {
  return (
    <Sonner
      theme={useResolvedTheme()}
      position="top-center"
      offset={BELOW_BAR}
      mobileOffset={BELOW_BAR}
      style={tokens}
    />
  );
}
