import { describe, expect, it } from "vitest";
import { labelSearchPath, statusMeta } from "./document-status";

describe("statusMeta", () => {
  it("describes each known status", () => {
    expect(statusMeta("draft")?.label).toBe("Draft");
    expect(statusMeta("in_review")?.label).toBe("In review");
    expect(statusMeta("approved")?.label).toBe("Approved");
    expect(statusMeta("archived")?.label).toBe("Archived");
  });

  it("returns nothing for an empty or unknown status", () => {
    expect(statusMeta()).toBeUndefined();
    expect(statusMeta("")).toBeUndefined();
    expect(statusMeta("done")).toBeUndefined();
  });
});

describe("labelSearchPath", () => {
  it("searches the documents page with the label operator", () => {
    expect(labelSearchPath("payments")).toBe("/app/documents?q=label%3Apayments");
  });
});
