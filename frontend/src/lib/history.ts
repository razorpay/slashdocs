// React Router's internal history.state.idx; > 0 means an in-app entry sits below.
export function canPopHistory(state: unknown): boolean {
  const idx =
    state && typeof state === "object" && "idx" in state ? state.idx : undefined;
  return typeof idx === "number" && Number.isInteger(idx) && idx > 0;
}
