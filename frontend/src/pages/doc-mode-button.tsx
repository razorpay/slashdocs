import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, TextCursor } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { rise, swap } from "@/lib/motion";
import { notSaved, useDoc, type SaveState } from "./doc-context";

// Why the edits on screen did not save.
const NOT_SAVED: Partial<Record<SaveState, string>> = {
  failed: "Your edits are not saved yet. Trying again.",
  paused: "The document changed elsewhere, so your latest edits are not saved.",
  refused: "A change cannot save. The message says why.",
};

// ModeButton starts Edit mode for a reader who can edit. Comment mode is the
// default, and needs no button. In Edit mode the button is Done, which
// leaves once the edits on screen are saved. It is one button, so that the
// focus stays on it as the mode changes: its width springs to the new
// label, and the labels cross-fade. It shows once the document takes edits.
export function ModeButton() {
  const { canEdit, editing, setEditing, frameReady } = useDoc();
  // Done waits while the edits on screen save.
  const [leaving, setLeaving] = useState(false);
  if (!canEdit) return null;
  // A second press while the edits save does nothing. The button stays
  // enabled, so that it keeps the focus.
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    await setEditing(false);
    setLeaving(false);
  };
  return (
    <div
      aria-hidden={!frameReady || undefined}
      className={cn(
        "flex shrink-0 items-center transition-opacity duration-150 ease-out",
        !frameReady && "invisible opacity-0",
      )}
    >
      {editing ? <SaveFailure /> : null}
      <Tooltip
        label={
          <Keys label={editing ? "Done" : "Edit"} shortcut={editing ? "Esc" : "E"} />
        }
      >
        <motion.button
          type="button"
          layout
          transition={{ layout: { type: "spring", duration: 0.2, bounce: 0 } }}
          aria-label={editing ? "Done" : "Edit"}
          aria-keyshortcuts={editing ? "Escape" : "E"}
          aria-busy={leaving || undefined}
          onClick={editing ? leave : () => void setEditing(true)}
          style={{ borderRadius: 6 }}
          className={cn(
            "relative flex shrink-0 items-center justify-center text-sm font-medium transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96]",
            editing
              ? "h-7 bg-[var(--color-accent)] px-2.5 text-[var(--color-accent-fg)] shadow-[var(--shadow-button-primary)] after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-[var(--color-accent-strong)]"
              : "size-8 text-[var(--color-fg)] hover:bg-[var(--color-highlight)] touch:size-10",
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={editing ? "done" : "edit"}
              layout="position"
              {...swap}
              className={cn("flex items-center gap-1.5", leaving && "busy-label")}
            >
              {editing ? (
                <>
                  Done
                  <kbd className="hidden rounded-[4px] bg-white/20 px-1 font-sans text-[11px] leading-4 text-white/80 xl:pointer-fine:inline-block">
                    Esc
                  </kbd>
                </>
              ) : (
                <TextCursor className="size-4" aria-hidden="true" />
              )}
            </motion.span>
          </AnimatePresence>
          {leaving ? (
            <LoaderCircle
              aria-hidden="true"
              className="busy-spinner absolute inset-0 m-auto size-4"
            />
          ) : null}
        </motion.button>
      </Tooltip>
    </div>
  );
}

// Keys gives a label with its shortcut, as the tooltips of the bar do.
function Keys({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      <kbd className="rounded bg-white/15 px-1 font-sans text-[11px]">{shortcut}</kbd>
    </span>
  );
}

// SaveFailure is the one state of a save that an editor sees: edits that did
// not save. Retry saves them at once, or says again why they cannot save,
// with the choices, as Copy my text.
function SaveFailure() {
  const { saveState, retrySave } = useDoc();
  return (
    <span role="status" aria-live="polite" className="flex">
      <AnimatePresence initial={false}>
        {notSaved(saveState) ? (
          <motion.span key="not-saved" {...rise} className="mr-2 flex">
            <Tooltip label={NOT_SAVED[saveState]}>
              <button
                type="button"
                onClick={retrySave}
                className="relative h-7 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-2.5 text-xs font-medium text-[var(--color-danger)] transition-[background-color,scale] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] active:scale-[0.96]"
              >
                <span className="max-sm:sr-only">Not saved ·</span> Retry
              </button>
            </Tooltip>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
