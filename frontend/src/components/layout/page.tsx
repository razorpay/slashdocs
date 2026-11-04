import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { beat } from "@/lib/enter";
import { Segmented } from "@/components/ui/segmented";
import { RazorSenseBackdrop } from "@/components/razorsense-backdrop";
import { cn } from "@/lib/cn";

// Slash's two content lanes: "app" for lists and grids, "focus" for one task
// at a time.
const LANE = { app: "max-w-[1136px]", focus: "max-w-[760px]" };

export function Page({
  lane = "app",
  backdrop = "page",
  className,
  children,
}: {
  lane?: keyof typeof LANE;
  backdrop?: "page" | "halo" | false;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative isolate min-h-full bg-[var(--color-bg)]">
      {backdrop && <RazorSenseBackdrop framing={backdrop} />}
      <div
        className={cn(
          // The top padding clears the floating app bar (h-14).
          "mx-auto px-4 pb-16 pt-20 md:px-8 md:pb-24 md:pt-24",
          LANE[lane],
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

// A title, one or two lines of description, and the page's own actions.
// There is no eyebrow: the rail already names the page.
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="enter text-xl font-semibold tracking-[-0.01em] md:text-2xl">
          {title}
        </h1>
        {description && (
          <p
            className="enter mt-1 max-w-[72ch] text-sm text-[var(--color-fg-muted)]"
            style={beat(1)}
          >
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="enter flex shrink-0 items-center gap-2" style={beat(1)}>
          {actions}
        </div>
      )}
    </header>
  );
}

const SETTINGS = [
  { value: "/app/settings/profile", label: "Profile" },
  { value: "/app/settings/developers", label: "Developers" },
  { value: "/app/settings/service-accounts", label: "Bots" },
];

// The settings pages, above their titles, so each is one click from the
// others.
export function SettingsNav() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  return (
    <Segmented
      label="Settings"
      value={pathname}
      options={SETTINGS}
      onChange={nav}
      className="enter mb-6 w-fit"
    />
  );
}
