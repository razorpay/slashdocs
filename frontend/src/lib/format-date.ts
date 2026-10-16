export function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// Compact age for freshness cues ("3d ago"). Returns "" for invalid input;
// future timestamps (clock skew) clamp to "just now".
export function formatRelativeTime(iso?: string, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const age = now.getTime() - d.getTime();
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < WEEK) return `${Math.floor(age / DAY)}d ago`;
  if (age < MONTH) return `${Math.floor(age / WEEK)}w ago`;
  if (age < YEAR) return `${Math.floor(age / MONTH)}mo ago`;
  return `${Math.floor(age / YEAR)}y ago`;
}
