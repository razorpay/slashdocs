import {
  Activity,
  Bot,
  Database,
  HardDrive,
  KeyRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/layout/logo";

// How a self-hosted install fits together: people and agents reach one
// binary, and the binary uses services that you already run.

type Node = readonly [LucideIcon, string, string];

const CLIENTS: Node[] = [
  [Users, "People", "Read and comment in the browser"],
  [Bot, "Agents", "Publish with the CLI or MCP"],
];

const SERVICES: Node[] = [
  [Database, "Postgres", "Comments, grants, and state"],
  [HardDrive, "Object storage", "The HTML of every version"],
  [KeyRound, "Sign-in", "Any OIDC provider"],
  [Activity, "Grafana", "A dashboard comes with it"],
];

const PARTS = ["Web app", "API", "MCP", "CLI downloads"];

export function Architecture() {
  return (
    <div className="grid items-center gap-y-3 md:grid-cols-[1fr_3rem_minmax(0,2.4fr)]">
      <Nodes items={CLIENTS} />
      <Wire />
      <div className="relative grid items-center gap-y-3 rounded-lg border border-dashed border-[var(--color-border-strong)] p-4 pt-8 md:grid-cols-[minmax(0,1.1fr)_3rem_1fr] md:p-6 md:pt-10">
        <span className="absolute left-4 top-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] md:left-6">
          Your infrastructure
        </span>
        <div className="razorsense-ring rounded-lg bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)]">
          <Logo className="h-5" />
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">One Go binary</p>
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {PARTS.map((part) => (
              <li
                key={part}
                className="rounded-full bg-[var(--color-accent-muted)] px-2.5 py-1 text-xs text-[var(--color-accent)]"
              >
                {part}
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-fg-muted)]">
            Documents render on a separate origin.
          </p>
        </div>
        <Wire />
        <Nodes items={SERVICES} />
      </div>
    </div>
  );
}

function Nodes({ items }: { items: Node[] }) {
  return (
    <ul className="grid gap-2">
      {items.map(([Icon, title, detail]) => (
        <li
          key={title}
          className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:border-transparent"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
            <Icon className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block truncate text-xs text-[var(--color-fg-muted)]">
              {detail}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// A connector: down the page on phones, across it on wide screens.
function Wire() {
  return (
    <span
      aria-hidden
      className="mx-auto h-6 w-px bg-[var(--color-border-strong)] md:h-px md:w-full"
    />
  );
}
