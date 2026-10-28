import { describe, expect, it } from "vitest";
import { formatRelative } from "./format-date";

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
