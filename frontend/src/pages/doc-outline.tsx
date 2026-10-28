import { PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import type { OutlineHeading } from "@/lib/outline";

// DocOutline lists the headings of the document like the outline of a Google
// Doc. Levels are indented from the highest level the document uses.
export function DocOutline({
  headings,
  active,
  onNavigate,
  onHide,
}: {
  headings: OutlineHeading[];
  active: string;
  onNavigate: (id: string) => void;
  onHide: () => void;
}) {
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <nav aria-label="Document outline" className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between pl-4 pr-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
          Outline
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onHide}
          aria-label="Hide outline"
          tooltip="Hide outline"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {headings.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onNavigate(h.id)}
              aria-current={h.id === active ? "location" : undefined}
              title={h.text}
              style={{ paddingLeft: `${0.5 + (h.level - top) * 0.875}rem` }}
              className={cn(
                "block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--color-surface-muted)]",
                h.level === top && "font-medium",
                h.id === active
                  ? "bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
