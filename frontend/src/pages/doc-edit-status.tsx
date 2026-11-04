import {
  AlertCircle,
  Check,
  Eye,
  LoaderCircle,
  MessageSquare,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useDoc, type SaveState } from "./doc-context";

type Status = { label: string; title: string; Icon: LucideIcon };

const STATUS: Record<SaveState, Status> = {
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
};

// What a reader who cannot change the words may do.
const ACCESS: Record<"commenter" | "viewer", Status> = {
  commenter: {
    label: "Can comment",
    title: "Select text to comment on it. Only editors change the words.",
    Icon: MessageSquare,
  },
  viewer: {
    label: "Can view",
    title: "You can read this document. Ask its owner for access to comment.",
    Icon: Eye,
  },
};

// EditStatus tells an editor that the document is theirs to edit, and whether
// their edits are saved. There is no edit mode to enter: they type. Other
// readers see what they may do. A narrow bar, short of room for the title,
// shows only the icon of a save.
export function EditStatus({ access }: { access?: keyof typeof ACCESS }) {
  const { editable, saveState } = useDoc();
  const status = editable ? STATUS[saveState] : access && ACCESS[access];
  if (!status) return null;
  const { label, title, Icon } = status;
  return (
    <span
      role="status"
      title={title}
      className={cn(
        "shrink-0 items-center gap-1 text-xs text-[var(--color-fg-muted)]",
        !editable || saveState === "idle" ? "hidden sm:inline-flex" : "inline-flex",
        editable && saveState === "failed" && "text-[var(--color-danger)]",
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
