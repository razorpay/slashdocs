// The public URL of this slashdocs instance, sourced from APP_ORIGIN on
// the server and injected into index.html at request time. Falls back
// to the current browser origin only in dev (Vite) where the
// placeholder isn't substituted.
declare global {
  interface Window {
    __SLASHDOCS_PUBLIC_URL__?: string;
  }
}

export function publicURL(): string {
  const injected = typeof window !== "undefined" ? window.__SLASHDOCS_PUBLIC_URL__ : "";
  if (injected && injected !== "__SLASHDOCS_PUBLIC_URL_VALUE__") {
    return injected.replace(/\/$/, "");
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}
