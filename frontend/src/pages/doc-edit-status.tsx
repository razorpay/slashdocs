import { AlertCircle, Check, Pencil, type LucideIcon } from "lucide-react";
import { useDoc, type SaveState } from "./doc-context";

const STATUS: Record<SaveState, { label: string; title: string; Icon?: LucideIcon }> = {
  idle: {
    label: "Editing",
    title: "Type in the document to change its words. Edits save as you type.",
    Icon: Pencil,
  },
  unsaved: { label: "Saving…", title: "Your edits save when you pause." },
  saving: { label: "Saving…", title: "Your edits save when you pause." },
  saved: { label: "Saved", title: "Every edit is in the history.", Icon: Check },
  failed: {
    label: "Not saved",
    title: "Your edits are not saved yet. Trying again.",
    Icon: AlertCircle,
  },
};

// EditStatus tells an editor that the document is theirs to edit, and whether
// their edits are saved. There is no edit mode to enter: they type.
export function EditStatus() {
  const { editable, saveState } = useDoc();
  if (!editable) return null;
  const { label, title, Icon } = STATUS[saveState];
  return (
    <span
      role="status"
      title={title}
      className={`hidden shrink-0 items-center gap-1 text-xs sm:inline-flex ${
        saveState === "failed"
          ? "text-[var(--color-danger)]"
          : "text-[var(--color-fg-muted)]"
      }`}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {label}
    </span>
  );
}
