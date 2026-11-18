import { describe, expect, it } from "vitest";
import { formatRelative, formatUntil, formatUntilShort } from "./format-date";

const at = (s: string) => new Date(s).getTime();
const now = at("2026-10-22T15:00:00");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatRelative", () => {
  it("reads as a person would", () => {
    expect(formatRelative(ago(10_000), now)).toBe("just now");
    expect(formatRelative(ago(-30_000), now)).toBe("just now"); // clock skew
    expect(formatRelative(ago(60_000), now)).toBe("1 minute ago");
    expect(formatRelative(ago(59.9 * 60_000), now)).toBe("59 minutes ago");
    expect(formatRelative(ago(2 * 3_600_000 + 1_000), now)).toBe("2 hours ago");
    expect(formatRelative(ago(23.9 * 3_600_000), now)).toBe("23 hours ago");
  });

  it("counts calendar days from a day back", () => {
    expect(formatRelative(new Date("2026-10-21T09:00:00").toISOString(), now)).toBe(
      "yesterday",
    );
    expect(formatRelative(new Date("2026-10-18T23:00:00").toISOString(), now)).toBe(
      "4 days ago",
    );
  });

  it("names the day from a week back, with the year only when it differs", () => {
    expect(formatRelative(new Date("2026-10-12T10:00:00").toISOString(), now)).toBe(
      "Oct 12",
    );
    expect(formatRelative(new Date("2025-12-30T10:00:00").toISOString(), now)).toBe(
      "Dec 30, 2025",
    );
  });

  it("is empty for a missing or bad time", () => {
    expect(formatRelative(undefined, now)).toBe("");
    expect(formatRelative("not a date", now)).toBe("");
  });
});

describe("formatUntil", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const until = (ms: number) => new Date(now + ms).toISOString();

  const cases: [string, number, string, string][] = [
    ["is soon at the time", 0, "soon", "soon"],
    ["is soon after the time", -5 * MIN, "soon", "soon"],
    ["is soon a millisecond after", -1, "soon", "soon"],
    [
      "says less than a minute at 1 second",
      1_000,
      "in less than a minute",
      "less than a minute",
    ],
    [
      "says less than a minute at 59 seconds",
      59_000,
      "in less than a minute",
      "less than a minute",
    ],
    ["says 1 minute at 60 seconds", 60_000, "in 1 minute", "1 minute"],
    ["floors minutes", 5 * MIN + 59_000, "in 5 minutes", "5 minutes"],
    ["says 59 minutes", 59 * MIN, "in 59 minutes", "59 minutes"],
    ["counts minutes in the first hour", HOUR, "in 60 minutes", "60 minutes"],
    ["says 90 minutes, not 2 hours", 90 * MIN, "in 90 minutes", "90 minutes"],
    ["says 119 minutes", 119 * MIN, "in 119 minutes", "119 minutes"],
    [
      "stays in minutes just before 2 hours",
      2 * HOUR - 1_000,
      "in 119 minutes",
      "119 minutes",
    ],
    ["says 2 hours at 2 hours", 2 * HOUR, "in 2 hours", "2 hours"],
    ["floors hours", 5 * HOUR + 40 * MIN, "in 5 hours", "5 hours"],
    ["says 23 hours at 23h40m", 23 * HOUR + 40 * MIN, "in 23 hours", "23 hours"],
    ["says 24 hours, not 1 day", DAY, "in 24 hours", "24 hours"],
    ["says 24 hours just after choosing 1 day", DAY - 2_000, "in 24 hours", "24 hours"],
    ["says 36 hours, not 2 days", 36 * HOUR, "in 36 hours", "36 hours"],
    ["says 47 hours", 47 * HOUR, "in 47 hours", "47 hours"],
    [
      "says 47 hours until the slack takes it to 2 days",
      47 * HOUR + 54 * MIN,
      "in 47 hours",
      "47 hours",
    ],
    ["says 2 days at 47h55m", 47 * HOUR + 55 * MIN, "in 2 days", "2 days"],
    ["says 2 days at 2 days", 2 * DAY, "in 2 days", "2 days"],
    ["floors days", 3 * DAY + 20 * HOUR, "in 3 days", "3 days"],
    ["says 3 days just after choosing 3 days", 3 * DAY - 2_000, "in 3 days", "3 days"],
    ["says 6 days an hour before 7 days", 7 * DAY - HOUR, "in 6 days", "6 days"],
    ["says 7 days just after choosing 7 days", 7 * DAY - 2_000, "in 7 days", "7 days"],
    [
      "says 7 days at 6d23h59m, inside the slack",
      6 * DAY + 23 * HOUR + 59 * MIN,
      "in 7 days",
      "7 days",
    ],
    [
      "says 90 days just after choosing 3 months",
      90 * DAY - 2_000,
      "in 90 days",
      "90 days",
    ],
  ];
  for (const [name, ms, long, short] of cases)
    it(name, () => {
      expect(formatUntil(until(ms), now)).toBe(long);
      expect(formatUntilShort(until(ms), now)).toBe(short);
    });

  it("is empty for a missing or bad time", () => {
    expect(formatUntil("", now)).toBe("");
    expect(formatUntil("not a date", now)).toBe("");
    expect(formatUntilShort("not a date", now)).toBe("");
  });
});
