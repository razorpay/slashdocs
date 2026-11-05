import {
  AlertCircle,
  Check,
  Eye,
  LoaderCircle,
  MessageSquare,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
    label: "Edited",
    title: "Your edits save when you pause.",
    Icon: Pencil,
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
  refused: {
    label: "Not saved",
    title: "A change cannot save. The message says why.",
    Icon: AlertCircle,
  },
};

// The longest label of a save, "Not saved", has 9 characters. The label
// keeps that width, so that the title does not move as the label changes.
const LABEL_WIDTH = "sm:min-w-[9ch]";

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
// shows only the icon of a save. A screen reader hears only that edits are
// not saved, not each save of a pause.
export function EditStatus({ access }: { access?: keyof typeof ACCESS }) {
  const { editable, saveState, text, frameReady } = useDoc();
  const status = editable ? STATUS[saveState] : access && ACCESS[access];
  if (!status) return null;
  const { label, title, Icon } = status;
  const failed = editable && Icon === AlertCircle;
  if (!editable)
    return (
      <Status
        label={label}
        title={title}
        Icon={Icon}
        failed={failed}
        className="hidden sm:inline-flex"
      />
    );
  const fade = "transition-opacity duration-150 ease-out motion-reduce:transition-none";
  return (
    // A phone has no Esc key to leave the text, so a touch screen shows Done
    // while the text has the caret. On a narrow bar Done takes the place of
    // the status. The place keeps its width in every state, so that the
    // title does not move. It shows once the document takes edits.
    <span
      aria-hidden={!frameReady || undefined}
      className={cn(
        "grid shrink-0 items-center justify-items-center *:col-start-1 *:row-start-1 sm:flex sm:gap-2",
        fade,
        !frameReady && "invisible opacity-0",
      )}
    >
      <Status
        label={label}
        title={title}
        Icon={Icon}
        failed={failed}
        className={cn(
          "inline-flex",
          fade,
          // Faded, it still paints over Done, so taps go through it.
          text?.focused &&
            "max-sm:pointer-coarse:pointer-events-none max-sm:pointer-coarse:opacity-0",
        )}
      />
      <Button
        size="sm"
        variant="secondary"
        className={cn(
          "hidden max-sm:px-2 max-sm:text-xs pointer-coarse:inline-flex",
          fade,
          !text?.focused && "invisible opacity-0",
        )}
        onClick={text?.leave}
      >
        Done
      </Button>
    </span>
  );
}

function Status({
  label,
  title,
  Icon,
  failed,
  className,
}: Status & { failed: boolean; className: string }) {
  return (
    <span
      role="status"
      aria-live={failed ? "polite" : "off"}
      title={title}
      className={cn(
        "shrink-0 items-center gap-1 text-xs text-[var(--color-fg-muted)]",
        className,
        failed && "text-[var(--color-danger)]",
      )}
    >
      <Icon
        className={`h-3.5 w-3.5 ${Icon === LoaderCircle ? "motion-safe:animate-spin" : ""}`}
        aria-hidden="true"
      />
      <span className={cn("sr-only sm:not-sr-only", LABEL_WIDTH)}>{label}</span>
    </span>
  );
}
