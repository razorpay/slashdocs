import { afterEach, expect, it } from "vitest";
import { brandLogo, productName, productSlug } from "./brand";

afterEach(() => {
  delete window.__SLASHDOCS_BRAND__;
});

it("keeps the slashdocs name and wordmark without a brand", () => {
  expect(productName()).toBe("slashdocs");
  expect(productSlug()).toBe("slashdocs");
  expect(brandLogo()).toBeNull();
});

it("uses the brand that the server injects", () => {
  window.__SLASHDOCS_BRAND__ = {
    name: "Acme Artifacts",
    logo: "/brand/logo.svg?v=1",
    logoDark: "/brand/logo-dark.svg?v=2",
  };
  expect(productName()).toBe("Acme Artifacts");
  expect(productSlug()).toBe("acme-artifacts");
  expect(brandLogo()).toEqual({
    light: "/brand/logo.svg?v=1",
    dark: "/brand/logo-dark.svg?v=2",
  });
});

it("falls back to slashdocs for a name without letters or digits", () => {
  window.__SLASHDOCS_BRAND__ = { name: " ✦ " };
  expect(productSlug()).toBe("slashdocs");
});
