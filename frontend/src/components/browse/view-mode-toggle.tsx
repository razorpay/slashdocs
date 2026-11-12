import { ArrowDownAZ, Clock, LayoutGrid, List, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { folderSortStore, viewModeStore, type SortOrder } from "@/lib/view-mode";

export function ViewModeToggle() {
  return (
    <Segmented
      value={viewModeStore.useStore()}
      onChange={viewModeStore.write}
      options={[
        { value: "gallery", label: "Gallery view", icon: LayoutGrid },
        { value: "list", label: "List view", icon: List },
      ]}
    />
  );
}

export function SortOrderToggle({ folderId }: { folderId: string }) {
  const orders = folderSortStore.useStore();
  return (
    <Segmented<SortOrder>
      value={orders[folderId] || "recent"}
      onChange={(order) => folderSortStore.write({ ...orders, [folderId]: order })}
      options={[
        { value: "recent", label: "Sort by recent activity", icon: Clock },
        { value: "name", label: "Sort by name", icon: ArrowDownAZ },
      ]}
    />
  );
}

// A segmented control, as in Slash: the muted track holds a raised choice.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon: LucideIcon }[];
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-sm bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] dark:ring-transparent">
      {options.map(({ value: option, label, icon: Icon }) => (
        <Tooltip key={option} label={label}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-[6px] text-[var(--color-fg-muted)] aria-pressed:bg-[var(--color-surface)] aria-pressed:text-[var(--color-fg)] aria-pressed:shadow-[var(--shadow-border)]"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            aria-label={label}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
