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
export const DAY = 24 * HOUR;

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

// SLACK is what formatUntil adds before it counts hours and days. A period
// that was set a moment ago is some seconds less than the period, and must
// read as the period.
const SLACK = 5 * MINUTE;

// formatUntil says how long it is until a time: "in 90 minutes", "in 36
// hours", "in 7 days". It is the same rule as the CLI and the MCP tools use,
// and it never says more than the time that is left, because the mark that
// shows it announces a delete: 36 hours are "36 hours", not "2 days". Below 2
// hours it counts minutes, below 2 days hours, and then days, each rounded
// down. Only the slack lifts the count: 1 day that was just set is "in 24
// hours", and 7 days "in 7 days", not "in 6 days". A time that passed is
// "soon", because the server deletes a little after it.
export function formatUntil(iso: string | undefined, now: number = Date.now()): string {
  const d = parseTimestamp(iso);
  if (!d) return "";
  const left = d.getTime() - now;
  if (left <= 0) return "soon";
  if (left < MINUTE) return "in less than a minute";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (left < 2 * HOUR) return rtf.format(Math.floor(left / MINUTE), "minute");
  if (left + SLACK < 2 * DAY)
    return rtf.format(Math.floor((left + SLACK) / HOUR), "hour");
  return rtf.format(Math.floor((left + SLACK) / DAY), "day");
}

// formatUntilShort is formatUntil without the "in": "3 days", "soon".
export function formatUntilShort(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  return formatUntil(iso, now).replace(/^in /, "");
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
