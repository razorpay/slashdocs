export type VimScrollAction =
  "line-down" | "line-up" | "half-page-down" | "half-page-up" | "top" | "bottom";

export interface VimScrollInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

// A tap of j or k scrolls one line. A held key glides at a steady speed
// until it comes up, about four times as fast as quick taps.
export const VIM_LINE_PX = 72;
export const VIM_GLIDE_PX_PER_MS = 1.5;

export function reduceVimScroll(
  input: VimScrollInput,
  gArmed: boolean,
): { action: VimScrollAction | null; gArmed: boolean } {
  if (input.metaKey || input.altKey) return { action: null, gArmed: false };
  if (input.ctrlKey) {
    if (input.key.toLowerCase() === "d") {
      return { action: "half-page-down", gArmed: false };
    }
    if (input.key.toLowerCase() === "u") {
      return { action: "half-page-up", gArmed: false };
    }
    return { action: null, gArmed: false };
  }
  if (input.key === "G") return { action: "bottom", gArmed: false };
  if (input.key === "g") {
    return gArmed ? { action: "top", gArmed: false } : { action: null, gArmed: true };
  }
  if (input.key === "j") return { action: "line-down", gArmed: false };
  if (input.key === "k") return { action: "line-up", gArmed: false };
  return { action: null, gArmed: false };
}
