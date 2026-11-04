import { Navigate, Outlet, useLocation } from "react-router-dom";
import { AccountMenu, GetStarted, TopBar } from "./topbar";
import { useMe } from "@/lib/hooks";
import { useSignInPath } from "@/lib/auth-state";
import { Center } from "@/components/ui/misc";
import { cn } from "@/lib/cn";

// The app bar of every page but a document, which has its own bar. A
// document that does not open shows this one.
export function AppBar() {
  const me = useMe();
  const user = me.data?.user || me.data?.principal;
  return (
    <TopBar>
      {user && (
        <>
          <GetStarted />
          <AccountMenu user={user} />
        </>
      )}
    </TopBar>
  );
}

export function AppShell() {
  const me = useMe();
  const loc = useLocation();
  const signInPath = useSignInPath();
  const documentPage = loc.pathname.startsWith("/app/d/");
  // A signed-out reader can open a document. The document page sends them
  // to sign in when the server does not let them read it.
  if (me.unauth && !documentPage) return <Navigate to={signInPath} replace />;
  if (me.isLoading) return <Center>Loading workspace…</Center>;
  if (!me.data && !me.unauth) return null;
  const fullscreenDocument =
    documentPage && new URLSearchParams(loc.search).get("fullscreen") === "1";
  return (
    <main
      className={cn(
        "relative h-full",
        fullscreenDocument ? "overflow-hidden" : "overflow-auto",
      )}
    >
      {!documentPage && <AppBar />}
      <Outlet />
    </main>
  );
}
