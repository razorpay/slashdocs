import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bot,
  Check,
  LogOut,
  Monitor,
  Moon,
  Rocket,
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
import { useTheme } from "@/lib/theme";
import type { Principal } from "@/api";

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
      className="razorsense-ring hidden h-8 items-center gap-2 rounded-full bg-[var(--color-surface)] px-3 text-sm font-medium sm:inline-flex"
    >
      <Rocket className="h-3.5 w-3.5 text-[var(--color-accent)]" />
      Get started
      <span className="font-mono text-xs text-[var(--color-fg-muted)]">
        {done}/{total}
      </span>
    </Link>
  );
}

export function AccountMenu({ user }: { user: Principal }) {
  const nav = useNavigate();
  const signOut = useSignOut();
  const { theme, setTheme } = useTheme();
  const { reset } = useOnboarding();
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-10 min-w-10 rounded-full transition-transform duration-150 ease-out active:scale-[0.96] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          aria-label="Account menu"
        >
          <Avatar src={user.picture_url} name={user.name || user.email || user.id} />
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
        <DropdownItem
          onSelect={() => {
            reset();
            nav("/app/start");
          }}
        >
          <Rocket className="h-4 w-4" /> Setup guide
        </DropdownItem>
        <DropdownItem onSelect={() => nav("/app/settings/profile")}>
          <UserIcon className="h-4 w-4" /> Profile
        </DropdownItem>
        <DropdownItem onSelect={() => nav("/app/developers")}>
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
