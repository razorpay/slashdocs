import {
  AlertCircle,
  Check,
  LoaderCircle,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useDoc, type SaveState } from "./doc-context";

const STATUS: Record<SaveState, { label: string; title: string; Icon: LucideIcon }> = {
  idle: {
    label: "Can edit",
    title:
      "Type in the document to change its words. Edits save as you type. Press Esc to use the keyboard shortcuts.",
    Icon: Pencil,
  },
  unsaved: {
    label: "Saving…",
    title: "Your edits save when you pause.",
    Icon: LoaderCircle,
  },
  saving: {
    label: "Saving…",
    title: "Your edits save when you pause.",
    Icon: LoaderCircle,
  },
  saved: { label: "Saved", title: "Every edit is in the history.", Icon: Check },
  failed: {
    label: "Not saved",
    title: "Your edits are not saved yet. Trying again.",
    Icon: AlertCircle,
  },
  paused: {
    label: "Not saved",
    title: "The document changed elsewhere, so your latest edits are not saved.",
    Icon: AlertCircle,
  },
};

// EditStatus tells an editor that the document is theirs to edit, and whether
// their edits are saved. There is no edit mode to enter: they type. A narrow
// bar, short of room for the title, shows only the icon of a save.
export function EditStatus() {
  const { editable, saveState } = useDoc();
  if (!editable) return null;
  const { label, title, Icon } = STATUS[saveState];
  return (
    <span
      role="status"
      title={title}
      className={cn(
        "shrink-0 items-center gap-1 text-xs text-[var(--color-fg-muted)]",
        saveState === "idle" ? "hidden sm:inline-flex" : "inline-flex",
        Icon === AlertCircle && "text-[var(--color-danger)]",
      )}
    >
      <Icon
        className={`h-3.5 w-3.5 ${Icon === LoaderCircle ? "motion-safe:animate-spin" : ""}`}
        aria-hidden="true"
      />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </span>
  );
}
