// The deployment's brand, which the server injects into index.html when an
// operator sets SLASHDOCS_BRAND_*. Without it, the app keeps the slashdocs
// name and wordmark.
declare global {
  interface Window {
    __SLASHDOCS_BRAND__?: { name?: string; logo?: string; logoDark?: string };
  }
}

export const DEFAULT_PRODUCT_NAME = "slashdocs";

function injectedBrand() {
  return typeof window !== "undefined" ? window.__SLASHDOCS_BRAND__ : undefined;
}

// productName is the name people see for this deployment.
export function productName(): string {
  return injectedBrand()?.name?.trim() || DEFAULT_PRODUCT_NAME;
}

// productSlug is productName as a lowercase identifier ("Acme Artifacts" →
// "acme-artifacts"), for MCP server names in commands and config files.
export function productSlug(): string {
  const slug = productName()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || DEFAULT_PRODUCT_NAME;
}

// brandLogo returns the URLs of the operator's logo, or null for the
// slashdocs wordmark. dark is the logo for the dark theme, when there is one.
export function brandLogo(): { light: string; dark?: string } | null {
  const brand = injectedBrand();
  if (!brand?.logo) {
    return null;
  }
  return { light: brand.logo, dark: brand.logoDark };
}
