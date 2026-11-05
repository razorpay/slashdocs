import { NotificationToggle } from "@/components/notification-toggle";
import { Page, PageHeader, SettingsNav } from "@/components/layout/page";
import { beat } from "@/lib/enter";
import { useTitle } from "@/lib/use-title";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitBranch, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { Avatar, Center, RetryButton, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useMe } from "@/lib/hooks";
import { principalColor } from "@/lib/principals";
import { useTheme } from "@/lib/theme";
import { useSignOut } from "@/lib/auth-state";
import { api, type GitHubStatus } from "@/api";
import { errorMessage } from "@/lib/errors";

export function ProfilePage() {
  useTitle("Profile");
  const me = useMe();
  const signOut = useSignOut();
  const { theme, setTheme } = useTheme();
  const user = me.data?.user || me.data?.principal;
  const qc = useQueryClient();
  const github = useQuery({
    queryKey: ["github-connection"],
    queryFn: api.githubStatus,
    retry: false,
    // The card shows the failure, with Retry.
    meta: { suppressGlobalError: true },
  });
  const disconnectGitHub = useMutation({
    mutationFn: api.githubDisconnect,
    onSuccess: () => {
      // The account that went, from the status before it loads again.
      const login = qc.getQueryData<GitHubStatus>(["github-connection"])?.login;
      qc.invalidateQueries({ queryKey: ["github-connection"] });
      toast.success(
        login ? `Disconnected GitHub account ${login}.` : "GitHub disconnected.",
      );
    },
    onError: (e) => toast.error(errorMessage(e, "Could not disconnect GitHub")),
  });

  if (me.isLoading) {
    return (
      <Page lane="focus" backdrop={false}>
        <Skeleton className="mb-8 h-8 w-40" />
        <Skeleton className="h-28 w-full" />
      </Page>
    );
  }
  if (me.error || !user) {
    return <Center>Could not load your profile.</Center>;
  }
  return (
    <Page lane="focus">
      <SettingsNav />
      <PageHeader
        title="Profile"
        description="How you appear, and how slashdocs works for you."
      />
      <div className="enter space-y-4" style={beat(2)}>
        {/* Narrow screens put Sign out under the identity. */}
        <Card className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <Avatar
              size={56}
              src={user.picture_url}
              name={user.name || user.email}
              color={me.data && principalColor(me.data.principal)}
            />
            <div className="min-w-0">
              <div className="font-heading text-lg font-medium">
                {user.name || "Signed-in user"}
              </div>
              <div className="break-all text-sm text-[var(--color-fg-muted)]">
                {user.email || user.id}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            busy={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose how slashdocs looks to you.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-0.5 rounded-sm bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] dark:ring-transparent">
              {(
                [
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                  ["system", "System", Monitor],
                ] as const
              ).map(([v, label, Icon]) => (
                <button
                  key={v}
                  onClick={() => setTheme(v)}
                  aria-pressed={theme === v}
                  className="flex h-9 items-center justify-center gap-2 rounded-[6px] text-sm text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] aria-pressed:bg-[var(--color-surface)] aria-pressed:text-[var(--color-fg)] aria-pressed:shadow-[var(--shadow-border)]"
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <NotificationToggle />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" /> GitHub
            </CardTitle>
            <CardDescription>
              Let documents fetch repository files through your GitHub account. Your
              OAuth token stays on the server and is never exposed to document code.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div className="min-w-0 text-sm">
              {github.isLoading
                ? "Checking connection…"
                : github.error
                  ? `Could not check the connection. ${errorMessage(github.error)}`
                  : github.data?.connected
                    ? `Connected as ${github.data.login}`
                    : github.data?.configured === false
                      ? "Not configured for this deployment"
                      : "Not connected"}
            </div>
            {github.error ? (
              <RetryButton query={github} variant="outline" />
            ) : github.data?.connected ? (
              <Button
                variant="outline"
                onClick={() => disconnectGitHub.mutate()}
                busy={disconnectGitHub.isPending}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => window.location.assign(api.githubConnectURL())}
                disabled={github.isLoading || github.data?.configured === false}
              >
                Connect GitHub
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
