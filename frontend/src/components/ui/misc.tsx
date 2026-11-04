import * as React from "react";
import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, type ButtonProps } from "./button";

// Controls that appear on hover or focus inside a `group`. Touch screens
// cannot hover, so the controls stay visible there.
export const revealOnHover =
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

// Collapse opens to the height of its content and closes to none. Closed, it
// takes no focus.
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className={cn("min-h-0 overflow-hidden", className)}>{children}</div>
    </div>
  );
}

export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} {...p} />;
}

const COPY_LABEL = { idle: "Copy", done: "Copied", failed: "Could not copy" };

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
  // The result of the last copy, for 1.5 s. A failed copy selects the text, so
  // the reader can copy it with the keyboard.
  const [copied, setCopied] = React.useState<"done" | "failed" | null>(null);
  const pre = React.useRef<HTMLPreElement>(null);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied("done");
    } catch {
      setCopied("failed");
      if (pre.current) window.getSelection()?.selectAllChildren(pre.current);
    }
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div
      className={cn(
        "group relative rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-mono text-xs",
        className,
      )}
    >
      {/* A long command scrolls with no scrollbar, and fades out under Copy. */}
      <pre
        ref={pre}
        className={cn(
          "p-3 pr-10 leading-relaxed text-[var(--color-fg)]",
          wrap
            ? "whitespace-pre-wrap"
            : "overflow-x-auto [mask-image:linear-gradient(to_left,transparent_2.25rem,black_3.5rem)] [scrollbar-width:none]",
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
            className={cn(
              "absolute right-1.5 top-1.5 h-8 min-h-8 w-8 rounded-md text-[var(--color-fg-muted)] transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.96] hover:bg-[var(--color-border)] hover:text-[var(--color-fg)]",
              revealOnHover,
            )}
            aria-label={COPY_LABEL[copied || "idle"]}
          >
            {copied === "done" ? (
              <Check className="h-3.5 w-3.5" />
            ) : copied === "failed" ? (
              <X className="h-3.5 w-3.5 text-[var(--color-danger)]" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <span className="sr-only" role="status" aria-live="polite">
            {copied === "done" ? "Copied to clipboard" : ""}
            {copied === "failed" ? "Could not copy. The text is selected." : ""}
          </span>
        </>
      )}
    </div>
  );
}

export type RetryQuery = { isFetching: boolean; refetch: () => unknown };

// RetryButton loads a query that failed again, and is busy while it does.
export function RetryButton({ query, ...props }: { query: RetryQuery } & ButtonProps) {
  return (
    <Button disabled={query.isFetching} onClick={() => query.refetch()} {...props}>
      {query.isFetching ? "Retrying…" : "Retry"}
    </Button>
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
        "flex flex-col items-center justify-center bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--razorsense-wash-from)_14%,transparent),transparent)] px-6 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          {icon}
        </div>
      )}
      <h3 className="text-balance font-heading text-base font-medium text-[var(--color-fg)]">
        {title}
      </h3>
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

// A photo, or else initials: white on the person's color when there is one
// (principalColor), or the accent tint.
export function Avatar({
  name,
  src,
  size = 32,
  color,
}: {
  name?: string;
  src?: string;
  size?: number;
  color?: string;
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
        background: color,
      }}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        color
          ? "text-white"
          : "bg-[var(--color-accent-muted)] text-[var(--color-accent)]",
      )}
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
