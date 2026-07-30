// React Router's internal history.state.idx; > 0 means an in-app entry sits below.
export function canPopHistory(state: unknown): boolean {
  const idx =
    state && typeof state === "object" && "idx" in state ? state.idx : undefined;
  return typeof idx === "number" && Number.isInteger(idx) && idx > 0;
}

// React Router puts Link/navigate `state` under history.state.usr.
export function isFullscreenEntry(state: unknown): boolean {
  if (!state || typeof state !== "object" || !("usr" in state)) return false;
  const usr = state.usr;
  return (
    !!usr &&
    typeof usr === "object" &&
    (usr as { aidocsFullscreen?: unknown }).aidocsFullscreen === true
  );
}
