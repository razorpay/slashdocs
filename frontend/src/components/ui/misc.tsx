import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} {...p} />;
}

export function CodeBlock({
  children,
  copy = true,
  wrap = false,
  className,
}: {
  children: string;
  copy?: boolean;
  // Wrap long lines. Use it for prose, such as a prompt, not for commands.
  wrap?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable in insecure contexts or was denied; leave the
      // button state untouched so we don't falsely report success.
    }
  };
  return (
    <div
      className={cn(
        "group relative rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-mono text-xs",
        className,
      )}
    >
      <pre
        className={cn(
          "overflow-x-auto p-3 pr-10 leading-relaxed text-[var(--color-fg)]",
          wrap && "whitespace-pre-wrap",
        )}
      >
        {children}
      </pre>
      {copy && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCopy}
            // 32px tall at 6px from the top: centered on the first line, so a
            // one-line block centers it too.
            className="absolute right-1.5 top-1.5 h-8 min-h-8 w-8 rounded-md text-[var(--color-fg-muted)] opacity-0 transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.96] hover:bg-[var(--color-border)] hover:text-[var(--color-fg)] group-hover:opacity-100 focus:opacity-100"
            aria-label={copied ? "Copied" : "Copy"}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Copied to clipboard" : ""}
          </span>
        </>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_srgb,var(--razorsense-wash-from)_14%,transparent),transparent_70%)] px-6 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          {icon}
        </div>
      )}
      <h3 className="text-balance font-heading text-base font-medium">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-pretty text-sm text-[var(--color-fg-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Center({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center p-10 text-sm text-[var(--color-fg-muted)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Avatar({
  name,
  src,
  size = 32,
}: {
  name?: string;
  src?: string;
  size?: number;
}) {
  const initials =
    (name || "?")
      .split(/\s+/)
      .map((x) => x[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  const showImg = src && !failed;
  return (
    <div
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.floor(size * 0.38)),
      }}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-accent-muted)] font-semibold text-[var(--color-accent)]"
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover outline outline-1 -outline-offset-1 outline-[rgba(0,0,0,0.1)] dark:outline-[rgba(255,255,255,0.1)]"
        />
      ) : (
        initials
      )}
    </div>
  );
}

export { Button };
