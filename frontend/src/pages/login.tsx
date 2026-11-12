import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { SiteFooter, SiteHeader } from "@/components/layout/site-chrome";
import { RazorSenseBackdrop } from "@/components/razorsense-backdrop";
import { publicURL } from "@/lib/config";
import { useMe } from "@/lib/hooks";
import { queryKeys } from "@/lib/queryKeys";
import { useTitle } from "@/lib/use-title";

export function LoginPage() {
  useTitle("Sign in");
  const [params] = useSearchParams();
  const next = params.get("next") || "/app/documents";
  const me = useMe();
  const config = useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
  });
  const provider = config.data?.provider_name ?? "SSO";
  const [redirecting, setRedirecting] = useState(false);
  // The back button can restore this page from the bfcache mid-redirect.
  useEffect(() => {
    const reset = () => setRedirecting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  if (me.data) return <Navigate to={next} replace />;
  return (
    <div className="relative isolate flex min-h-full flex-col overflow-x-clip bg-[var(--color-bg)]">
      <RazorSenseBackdrop framing="halo" className="h-[760px]" />
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="glass-card enter w-full max-w-sm rounded-lg p-8 text-center">
          <h1 className="text-2xl font-normal tracking-[-0.02em]">
            Sign in to slashdocs
          </h1>
          <p className="mt-2 font-mono text-xs text-[var(--color-fg-muted)]">
            {new URL(publicURL()).host}
          </p>
          <Button
            asChild
            variant="outline"
            size="lg"
            className="mt-8 w-full aria-disabled:pointer-events-none aria-disabled:opacity-70"
          >
            {/* nosemgrep: typescript.react.react-href-url.react-href-url - api.loginURL always returns a same-origin relative path and URL-encodes next as a query parameter. */}
            <a
              href={api.loginURL(next)}
              aria-disabled={redirecting}
              onClick={() => setRedirecting(true)}
            >
              {redirecting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                provider === "Google" && <GoogleIcon />
              )}
              {redirecting ? `Opening ${provider}…` : `Continue with ${provider}`}
            </a>
          </Button>
          <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
            Agents sign in from the terminal with{" "}
            <code className="whitespace-nowrap font-mono text-[var(--color-fg)]">
              slashdocs auth login
            </code>
            .
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <path d="M21.35 11.1H12v2.9h5.35c-.23 1.45-1.7 4.25-5.35 4.25-3.22 0-5.85-2.67-5.85-5.95s2.63-5.95 5.85-5.95c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.66 3.78 14.55 2.8 12 2.8 6.92 2.8 2.8 6.92 2.8 12s4.12 9.2 9.2 9.2c5.31 0 8.83-3.73 8.83-8.98 0-.6-.06-1.06-.15-1.51z" />
    </svg>
  );
}
