import { Navigate, Outlet, useLocation } from "react-router-dom";
import { AccountMenu, GetStarted, TopBar } from "./topbar";
import { useMe } from "@/lib/hooks";
import { useSignInPath } from "@/lib/auth-state";
import { Center } from "@/components/ui/misc";
import { cn } from "@/lib/cn";

export function AppShell() {
  const me = useMe();
  const loc = useLocation();
  const signInPath = useSignInPath();
  const documentPage = loc.pathname.startsWith("/app/d/");
  // A book chapter has its own bar, as a document does, but needs sign-in.
  const chapterPage = /^\/app\/b\/[^/]+\/c\//.test(loc.pathname);
  // A signed-out reader can open a document. The document page sends them
  // to sign in when the server does not let them read it.
  if (me.unauth && !documentPage) return <Navigate to={signInPath} replace />;
  if (me.isLoading) return <Center>Loading workspace…</Center>;
  if (!me.data && !me.unauth) return null;
  const user = me.data?.user || me.data?.principal;
  const fullscreenDocument =
    (documentPage || chapterPage) &&
    new URLSearchParams(loc.search).get("fullscreen") === "1";
  return (
    <main
      className={cn(
        "relative h-full",
        fullscreenDocument ? "overflow-hidden" : "overflow-auto",
      )}
    >
      {!documentPage && !chapterPage && user && (
        <TopBar>
          <GetStarted />
          <AccountMenu user={user} />
        </TopBar>
      )}
      <Outlet />
    </main>
  );
}
