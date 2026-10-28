import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownItem } from "@/components/ui/dropdown";

export function ResizeTablesMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect}>
      <Table2 className="h-4 w-4" /> Resize tables
    </DropdownItem>
  );
}

// TableResizeBar floats over the document while the reader resizes tables.
export function TableResizeBar({
  changed,
  saving,
  onCancel,
  onSave,
}: {
  changed: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Resize tables"
      className="absolute left-1/2 top-3 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--color-surface)] py-1.5 pl-4 pr-1.5 text-sm shadow-lg ring-1 ring-[var(--color-border)]"
    >
      <span className="truncate text-[var(--color-fg-muted)]">
        Drag any line of a table to resize it.
      </span>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button size="sm" onClick={onSave} disabled={!changed || saving}>
        {saving ? "Saving…" : "Save as new version"}
      </Button>
    </div>
  );
}
