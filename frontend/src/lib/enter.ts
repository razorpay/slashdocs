import type { CSSProperties } from "react";

// The stagger step for an `.enter` block: each beat starts 60ms later.
export const beat = (n: number) => ({ "--beat": n }) as CSSProperties;
