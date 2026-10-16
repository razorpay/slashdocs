import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatTimestamp } from "./format-date";

describe("formatTimestamp", () => {
  it("returns empty for missing or invalid input", () => {
    expect(formatTimestamp(undefined)).toBe("");
    expect(formatTimestamp("not-a-date")).toBe("");
  });

  it("formats a valid timestamp", () => {
    expect(formatTimestamp("2026-10-11T09:30:00Z")).not.toBe("");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  it("returns empty for missing or invalid input", () => {
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });

  it("clamps future timestamps to just now", () => {
    expect(formatRelativeTime("2026-10-11T12:05:00Z", now)).toBe("just now");
  });

  it("reports sub-minute ages as just now", () => {
    expect(formatRelativeTime("2026-10-11T11:59:30Z", now)).toBe("just now");
  });

  it("reports minutes, hours, days, weeks, months, and years", () => {
    expect(formatRelativeTime("2026-10-11T11:45:00Z", now)).toBe("15m ago");
    expect(formatRelativeTime("2026-10-11T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-10-09T12:00:00Z", now)).toBe("2d ago");
    expect(formatRelativeTime("2026-09-27T12:00:00Z", now)).toBe("2w ago");
    expect(formatRelativeTime("2026-06-11T12:00:00Z", now)).toBe("4mo ago");
    expect(formatRelativeTime("2024-10-11T12:00:00Z", now)).toBe("2y ago");
  });
});
