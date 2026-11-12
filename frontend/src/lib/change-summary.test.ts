import { describe, expect, it } from "vitest";
import { changeSummaryLines } from "./change-summary";

describe("changeSummaryLines", () => {
  it("splits lines and drops list markers and blank lines", () => {
    expect(
      changeSummaryLines("- Fix typo\n\n* Add table\r\n• Drop intro\nPlain"),
    ).toEqual(["Fix typo", "Add table", "Drop intro", "Plain"]);
  });

  it("keeps a one-line summary with semicolons whole", () => {
    expect(changeSummaryLines("Fix typo; add table")).toEqual(["Fix typo; add table"]);
  });

  it("returns nothing for an empty summary", () => {
    expect(changeSummaryLines(undefined)).toEqual([]);
    expect(changeSummaryLines(" \n ")).toEqual([]);
  });
});
