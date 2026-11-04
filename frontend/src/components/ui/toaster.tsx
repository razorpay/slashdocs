import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "@/lib/theme";
import { useIsMobile } from "@/lib/use-media-query";

// Toasts follow the app's theme and use its surface colors. On a narrow
// screen they show at the top, clear of the comment sheets at the bottom, and
// below the 56px bar, so that they do not cover its actions.
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
      position={useIsMobile() ? "top-center" : "bottom-right"}
      offset={BELOW_BAR}
      mobileOffset={BELOW_BAR}
      style={tokens}
    />
  );
}
