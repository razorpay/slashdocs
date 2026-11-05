import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bot,
  Check,
  Inbox,
  LogOut,
  Monitor,
  Moon,
  Rocket,
  RotateCw,
  Sun,
  Terminal,
  User as UserIcon,
} from "lucide-react";
import { Logo } from "./logo";
import { onboardingActive, onboardingProgress, useOnboarding } from "@/lib/onboarding";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { useSignOut } from "@/lib/auth-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAccessRequests, useMe } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { principalColor, principalLabel } from "@/lib/principals";
import type { Principal } from "@/api";
import { cn } from "@/lib/cn";

// The app bar sits on the page, as the landing header does, so the
// RazorSense wash runs behind it. The negative margin starts the page under it.
// The children are the actions on the right.
export function TopBar({
  home = "/app/documents",
  children,
}: {
  home?: string;
  children?: ReactNode;
}) {
  return (
    <header className="relative z-30 -mb-14 flex h-14 items-center justify-between px-4 md:px-6">
      <Link to={home} aria-label="slashdocs home">
        <Logo className="h-[18px] w-auto" />
      </Link>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

// Setup progress, while setup is open. It takes the RazorSense ring, as the
// one thing on the bar that asks for attention.
export function GetStarted() {
  const { state } = useOnboarding();
  if (!onboardingActive(state)) return null;
  const { done, total } = onboardingProgress(state);
  return (
    <Link
      to="/app/start"
      aria-label={`Get started: ${done} of ${total} complete`}
      className="razorsense-ring inline-flex h-8 items-center gap-2 rounded-full bg-[var(--color-surface)] px-3 text-sm font-medium"
    >
      <Rocket className="h-3.5 w-3.5 text-[var(--color-accent)]" />
      <span className="max-sm:hidden">Get started</span>
      <span className="font-mono text-xs text-[var(--color-fg-muted)]">
        {done}/{total}
      </span>
    </Link>
  );
}

// The requests for access on every document that the reader shares. Each one
// opens the share sheet of its document. With no request, nothing shows. A
// list that did not load shows a quiet mark and Retry, not an empty list.
export function AccessRequestsMenu() {
  const nav = useNavigate();
  const requests = useAccessRequests();
  const items = requests.data?.items ?? [];
  const failed = requests.isError && !requests.data;
  if (!items.length && !failed) return null;
  const label = failed
    ? "Requests for access did not load"
    : `${items.length} ${items.length === 1 ? "request" : "requests"} for access`;
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative min-h-10 min-w-10 rounded-full"
          tooltip="Requests for access"
          aria-label={label}
        >
          <Inbox className="h-4 w-4" />
          <span
            data-state="open"
            className={cn(
              "pop absolute right-1 top-1 min-w-4 rounded-full px-1 text-[10px] font-medium leading-4 tabular-nums text-white",
              failed ? "bg-[var(--color-fg-muted)]" : "bg-[var(--color-accent)]",
            )}
          >
            {failed ? "!" : items.length}
          </span>
        </Button>
      </DropdownTrigger>
      <DropdownContent className="w-80">
        <DropdownLabel>Requests for access</DropdownLabel>
        {failed ? (
          <>
            <p className="px-2 pb-1 text-xs text-[var(--color-fg-muted)]">
              Could not load the requests for access.
            </p>
            <DropdownItem
              disabled={requests.isFetching}
              // The menu stays open, so the list shows when it loads.
              onSelect={(e) => {
                e.preventDefault();
                requests.refetch();
              }}
            >
              <RotateCw className="h-4 w-4" />
              {requests.isFetching ? "Retrying…" : "Retry"}
            </DropdownItem>
          </>
        ) : null}
        {items.map((r) => (
          <DropdownItem
            key={`${r.document_id}:${r.requester.type}:${r.requester.id}`}
            onSelect={() => nav(`/app/d/${r.document_id}?share=1`)}
          >
            <Avatar
              size={24}
              src={r.requester.picture_url}
              name={principalLabel(r.requester)}
              color={principalColor(r.requester)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <span className="font-medium">{principalLabel(r.requester)}</span> asks
                for {r.document_title}
              </span>
              <span className="block text-xs text-[var(--color-fg-muted)]">
                <RelativeTime iso={r.requested_at} prefix="Asked" />
              </span>
            </span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

export function AccountMenu({ user }: { user: Principal }) {
  const nav = useNavigate();
  const signOut = useSignOut();
  const { theme, setTheme } = useTheme();
  // The profile user has no principal type, so the color comes from the
  // principal, as on pins and comments.
  const principal = useMe().data?.principal;
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-10 min-w-10 rounded-full transition-transform duration-150 ease-out active:scale-[0.96]"
          aria-label="Account menu"
        >
          <Avatar
            src={user.picture_url}
            name={user.name || user.email || user.id}
            color={principal && principalColor(principal)}
          />
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        <div className="px-2 py-2">
          <div className="text-sm font-medium">{user.name || "Signed in"}</div>
          <div className="text-xs text-[var(--color-fg-muted)]">
            {user.email || user.id}
          </div>
        </div>
        <DropdownSeparator />
        <DropdownItem onSelect={() => nav("/app/start")}>
          <Rocket className="h-4 w-4" /> Setup guide
        </DropdownItem>
        <DropdownItem onSelect={() => nav("/app/settings/profile")}>
          <UserIcon className="h-4 w-4" /> Profile
        </DropdownItem>
        <DropdownItem onSelect={() => nav("/app/settings/developers")}>
          <Terminal className="h-4 w-4" /> Developers
        </DropdownItem>
        <DropdownItem onSelect={() => nav("/app/settings/service-accounts")}>
          <Bot className="h-4 w-4" /> Bots
        </DropdownItem>
        <DropdownSeparator />
        <DropdownLabel>Theme</DropdownLabel>
        {(
          [
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "System", icon: Monitor },
          ] as const
        ).map(({ value, label, icon: Icon }) => (
          <DropdownItem
            key={value}
            onSelect={(e) => {
              e.preventDefault();
              setTheme(value);
            }}
          >
            <Icon className="h-4 w-4" /> {label}
            {theme === value && <Check className="ml-auto h-4 w-4" />}
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
