import { Navigate, Outlet, useLocation } from "react-router-dom";
import { CloudOff, LogOut } from "lucide-react";
import { AccessRequestsMenu, AccountMenu, GetStarted, TopBar } from "./topbar";
import { useMe } from "@/lib/hooks";
import { useSignInPath, useSignOut } from "@/lib/auth-state";
import { Button } from "@/components/ui/button";
import { Center, RetryButton } from "@/components/ui/misc";
import { ErrorState } from "@/components/error-state";
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
          <AccessRequestsMenu />
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
  const signOut = useSignOut();
  const documentPage = loc.pathname.startsWith("/app/d/");
  // A signed-out reader can open a document. The document page sends them
  // to sign in when the server does not let them read it.
  if (me.unauth && !documentPage) return <Navigate to={signInPath} replace />;
  if (me.isLoading) return <Center>Loading workspace…</Center>;
  // A workspace that did not load keeps the bar with the logo, and offers a
  // way out if it does not load again.
  if (!me.data && !me.unauth)
    return (
      <main className="relative h-full overflow-auto">
        <AppBar />
        <ErrorState
          title="Could not load your workspace"
          description="Check your connection, then try again."
          icon={<CloudOff className="h-5 w-5" />}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <RetryButton query={me} />
              <Button
                variant="outline"
                disabled={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            </div>
          }
        />
      </main>
    );
  const fullscreenDocument =
    documentPage && new URLSearchParams(loc.search).get("fullscreen") === "1";
  return (
    // A page keeps room for its scroll bar, so that it does not move when the
    // bar comes and goes. The document page does not scroll.
    <main
      className={cn(
        "relative h-full",
        fullscreenDocument ? "overflow-hidden" : "overflow-auto",
        !documentPage && "[scrollbar-gutter:stable]",
      )}
    >
      {!documentPage && <AppBar />}
      <Outlet />
    </main>
  );
}
