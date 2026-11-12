// formatTimestamp gives the full date and time, as in "Oct 22, 2026, 11:45 AM".
export function formatTimestamp(iso?: string): string {
  const d = parseTimestamp(iso);
  if (!d) return "";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// formatRelative says how long ago a time was, as a person would: "just now",
// "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". From a week back
// it names the day instead ("Oct 12"), with the year when it is not this year.
// A time a little in the future, from clock skew, reads "just now".
export function formatRelative(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  const d = parseTimestamp(iso);
  if (!d) return "";
  const ago = now - d.getTime();
  if (ago < 45_000) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (ago < HOUR) return rtf.format(-Math.max(1, Math.floor(ago / MINUTE)), "minute");
  if (ago < DAY) return rtf.format(-Math.floor(ago / HOUR), "hour");
  // From a day back, days are calendar days: two days ago at 11 PM is "2 days ago".
  const days = calendarDaysBetween(d, new Date(now));
  if (days < 7) return rtf.format(-Math.max(1, days), "day");
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function calendarDaysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / DAY);
}

function parseTimestamp(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
