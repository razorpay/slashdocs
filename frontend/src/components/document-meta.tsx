import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { labelSearchPath, statusMeta } from "@/lib/document-status";

export function StatusDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  );
}

export function StatusBadge({
  status,
  className,
}: {
  status?: string;
  className?: string;
}) {
  const meta = statusMeta(status);
  if (!meta) return null;
  return (
    <Badge
      variant="muted"
      className={cn("shrink-0 gap-1.5 whitespace-nowrap", className)}
      title={`Status: ${meta.label}`}
    >
      <StatusDot color={meta.color} />
      {meta.label}
    </Badge>
  );
}

// LabelChips renders labels that open the library filtered to that label.
// Chips stop pointer and click events so they work inside draggable cards
// and card links.
export function LabelChips({
  labels,
  max = 3,
  className,
}: {
  labels?: string[];
  max?: number;
  className?: string;
}) {
  const nav = useNavigate();
  if (!labels?.length) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => (
        <button
          key={label}
          type="button"
          title={`Show documents labeled ${label}`}
          className="min-w-0 max-w-[9rem] shrink cursor-pointer truncate rounded-full bg-[var(--color-accent-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-accent)] transition-colors duration-150 hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            nav(labelSearchPath(label));
          }}
        >
          {label}
        </button>
      ))}
      {rest > 0 ? (
        <Badge
          variant="muted"
          className="shrink-0"
          title={labels.slice(max).join(", ")}
        >
          +{rest}
        </Badge>
      ) : null}
    </span>
  );
}
