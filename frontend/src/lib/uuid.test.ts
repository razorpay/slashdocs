import { afterEach, describe, expect, it } from "vitest";
import { randomId } from "./uuid";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  const originalRandomUUID = crypto.randomUUID;

  afterEach(() => {
    viRestore();
  });

  function viRestore() {
    Object.defineProperty(crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
  }

  it("returns a valid v4 UUID", () => {
    expect(randomId()).toMatch(UUID_RE);
  });

  it("returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });

  it("falls back when crypto.randomUUID is missing (insecure origin)", () => {
    // Insecure origins don't expose the API at all, so the property reads as
    // undefined; defineProperty because `delete` can't remove prototype members.
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(crypto.randomUUID).toBeUndefined();
    expect(randomId()).toMatch(UUID_RE);
  });
});
