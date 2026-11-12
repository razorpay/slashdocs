import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, TextCursor } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useOnline } from "@/lib/hooks";
import { rise, swap } from "@/lib/motion";
import { notSaved, useDoc, type SaveState } from "./doc-context";

// Why the edits on screen did not save.
const NOT_SAVED: Partial<Record<SaveState, string>> = {
  failed: "Your edits are not saved yet. Trying again.",
  refused: "A change cannot save. The message says why.",
};
const OFFLINE = "Your edits are kept here. They save when you are online again.";
const CHIP = "h-7 rounded-full px-2.5 text-xs font-medium";
// The button and its label move with one spring, so that they stop together.
const RESIZE = { layout: { type: "spring", duration: 0.2, bounce: 0 } } as const;

// ModeButton starts Edit mode for a reader who can edit. Comment mode is the
// default, and needs no button. In Edit mode the button is Done, which
// leaves after the edits on screen went to the server. Edits that the
// server cannot get now go on by themselves. Edit mode stays only when a
// change cannot save. It is one button, so that the focus stays on it as
// the mode changes: its width springs to the new label, and the new label
// fades in. It shows once the document takes edits.
export function ModeButton() {
  const { canEdit, editing, setEditing, frameReady } = useDoc();
  // Done waits while the edits on screen go to the server.
  const [leaving, setLeaving] = useState(false);
  if (!canEdit) return null;
  // A second press while the edits go does nothing. The button stays
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
      <SaveFailure />
      <Tooltip
        label={
          <Keys label={editing ? "Done" : "Edit"} shortcut={editing ? "Esc" : "E"} />
        }
      >
        <motion.button
          type="button"
          layout
          transition={RESIZE}
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
          {/* Each mode mounts a new label, so that two labels never show
              together while the button changes its size. */}
          <motion.span
            key={editing ? "done" : "edit"}
            layout="position"
            transition={RESIZE}
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
// not get to the server for some time, or that cannot save. It also shows
// after Done, while the server does not hold the edits. Retry sends them at
// once, or says again why they cannot save, with the choices, as Copy my
// text. A browser with no network sends the edits by itself when the network
// is back, so the editor then sees only that they are offline.
function SaveFailure() {
  const { saveState, retrySave } = useDoc();
  const online = useOnline();
  const offline = saveState === "failed" && !online;
  return (
    <span role="status" aria-live="polite" className="flex">
      <AnimatePresence initial={false}>
        {notSaved(saveState) ? (
          <motion.span key="not-saved" {...rise} className="mr-2 flex">
            <Tooltip label={offline ? OFFLINE : NOT_SAVED[saveState]}>
              {offline ? (
                <span
                  className={cn(
                    CHIP,
                    "flex cursor-default items-center bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]",
                  )}
                >
                  Offline
                </span>
              ) : (
                <button
                  type="button"
                  onClick={retrySave}
                  className={cn(
                    CHIP,
                    "relative bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)] transition-[background-color,scale] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] active:scale-[0.96]",
                  )}
                >
                  <span className="max-sm:sr-only">Not saved ·</span> Retry
                </button>
              )}
            </Tooltip>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
