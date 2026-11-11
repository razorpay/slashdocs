import {
  AlertCircle,
  Check,
  Eye,
  LoaderCircle,
  MessageSquare,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { popIn } from "@/lib/motion";
import { createPersistentStore } from "@/lib/persistent-store";
import { useDoc, type SaveState } from "./doc-context";

type Status = { label: string; title: string; Icon: LucideIcon };

const STATUS: Record<SaveState, Status> = {
  idle: {
    label: "Editing",
    title:
      "Type in the document to change its words. Edits save as you type. Done, C or Esc goes back to commenting.",
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

// EditStatus tells an editor in Edit mode whether their edits are saved,
// with Done, which leaves Edit mode once they are. Other readers see what
// they may do. A narrow bar, short of room for the title, shows only the icon
// of a save. A screen reader hears only that edits are not saved, not each
// save of a pause. The first time, the bar says how Edit mode works. For a
// while after a save that can be undone, it says what the save changed, with
// Undo, where it covers no words.
export function EditStatus({ access }: { access?: keyof typeof ACCESS }) {
  const { canEdit, editing, setEditing, saveState, saveNote } = useDoc();
  const hint = useEditHint(editing);
  // Done waits while the edits on screen save.
  const [leaving, setLeaving] = useState(false);
  if (!canEdit) {
    const status = access && ACCESS[access];
    return status ? (
      <Status {...status} failed={false} className="hidden sm:inline-flex" />
    ) : null;
  }
  const status = STATUS[saveState];
  const failed = status.Icon === AlertCircle;
  // The note of a save is news, and takes the place of the hint.
  const note = failed ? undefined : saveNote;
  const hinted = hint && !failed && !note;
  // A later state of a save says itself. Undo stays for its while.
  const noted = !!note && saveState === "saved";
  const label = noted ? (
    <span className="inline-flex min-w-0 gap-1">
      <span>{status.label}</span>
      <span className="max-w-[32ch] truncate" title={note.said}>
        · {note.said}
      </span>
    </span>
  ) : hinted ? (
    "Editing. Changes save as you type."
  ) : (
    status.label
  );
  return (
    <AnimatePresence initial={false}>
      {editing ? (
        <motion.span
          key="editing"
          {...popIn}
          className="flex shrink-0 items-center gap-2"
        >
          <Status
            {...status}
            label={label}
            failed={failed}
            live={hinted || noted}
            className="inline-flex"
          />
          <Button
            size="sm"
            busy={leaving}
            className="shrink-0 max-sm:px-2 max-sm:text-xs"
            onClick={async () => {
              setLeaving(true);
              await setEditing(false);
              setLeaving(false);
            }}
          >
            Done
          </Button>
          {note?.undo ? (
            <Button
              size="sm"
              variant="ghost"
              className="enter shrink-0 max-sm:px-2 max-sm:text-xs"
              onClick={note.undo}
            >
              Undo
            </Button>
          ) : null}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

const editHintSeen = createPersistentStore<boolean>("slashdocs:edit-hint-seen", false);
const HINT_MS = 8000;

// useEditHint tells whether the bar shows the hint that an editor gets once,
// the first time they start Edit mode: that their changes save as they type.
// It shows for a while in place of the status, where it covers no words.
function useEditHint(editing: boolean): boolean {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!editing || editHintSeen.read()) return;
    editHintSeen.write(true);
    setHint(true);
  }, [editing]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);
  return hint;
}

function Status({
  label,
  title,
  Icon,
  failed,
  live,
  className,
}: Omit<Status, "label"> & {
  label: ReactNode;
  failed: boolean;
  live?: boolean;
  className: string;
}) {
  return (
    <span
      role="status"
      aria-live={failed || live ? "polite" : "off"}
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
