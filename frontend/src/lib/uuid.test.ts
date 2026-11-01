import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./uuid";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a valid v4 UUID", () => {
    expect(randomId()).toMatch(UUID_RE);
  });

  it("returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });

  it("falls back when crypto.randomUUID is missing (insecure origin)", () => {
    // Insecure origins expose crypto.getRandomValues but not crypto.randomUUID.
    const webCrypto = crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
    });
    expect(randomId()).toMatch(UUID_RE);
  });
});
