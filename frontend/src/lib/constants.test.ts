import { describe, expect, it } from "vitest";
import { canManageSharing } from "./constants";

describe("canManageSharing", () => {
  it("admits only the owner", () => {
    expect(canManageSharing("owner")).toBe(true);
  });

  // Editors write document content; deciding who else gets in is the owner's.
  it("refuses editors", () => {
    expect(canManageSharing("editor")).toBe(false);
  });

  // The regression this gate exists for: a commenter who could manage sharing
  // could grant themselves editor, and could revoke the general-access grant
  // that was their own and everyone else's only route to the document.
  it("refuses commenters", () => {
    expect(canManageSharing("commenter")).toBe(false);
  });

  it("refuses viewers and unknown roles", () => {
    expect(canManageSharing("viewer")).toBe(false);
    expect(canManageSharing(undefined)).toBe(false);
    expect(canManageSharing("")).toBe(false);
  });
});
