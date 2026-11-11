import type { KeyboardEvent } from "react";
import { MessageCircle, TextCursor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STEPS } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useDoc } from "./doc-context";

const MODES = [
  { editing: false, label: "Comment", key: "C", Icon: MessageCircle },
  { editing: true, label: "Edit", key: "E", Icon: TextCursor },
];

// ModeSwitch lets an editor comment on the document, as every reader does,
// or type in it. It is a radio group with one tab stop: the arrow keys, Home
// and End move to a mode and pick it, as in a Segmented control. The raised
// pill slides to the picked mode. A narrow bar has room for one button, as
// in Google Docs on a phone: Edit, which Done replaces in Edit mode. It shows
// once the document takes edits.
export function ModeSwitch() {
  const { canEdit, editing, setEditing, frameReady } = useDoc();
  if (!canEdit) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = step(Number(editing), MODES.length);
    void setEditing(MODES[next].editing);
    event.currentTarget.querySelectorAll("button")[next]?.focus();
  };
  const shown = cn(
    "shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
    !frameReady && "invisible opacity-0",
  );
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Mode"
        aria-hidden={!frameReady || undefined}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex rounded-[10px] bg-[var(--color-surface-muted)] p-0.5 ring-1 ring-[var(--color-border)] max-sm:hidden dark:ring-transparent",
          shown,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0.5 top-0.5 size-8 rounded-[8px] bg-[var(--color-surface)] shadow-[var(--shadow-border)] transition-transform duration-[180ms] ease-out motion-reduce:transition-none",
            editing && "translate-x-full",
          )}
        />
        {MODES.map(({ editing: on, label, key, Icon }) => (
          <Tooltip
            key={key}
            label={
              <span className="flex items-center gap-2">
                {label}
                <kbd className="rounded bg-white/15 px-1 font-sans text-[11px]">
                  {key}
                </kbd>
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={editing === on}
              aria-label={label}
              aria-keyshortcuts={key}
              tabIndex={editing === on ? 0 : -1}
              onClick={() => void setEditing(on)}
              className="relative grid size-8 place-items-center rounded-[8px] text-[var(--color-fg-muted)] transition-[color,scale] duration-150 ease-out before:absolute before:-inset-y-1 before:inset-x-0 hover:text-[var(--color-fg)] active:scale-[0.96] aria-checked:text-[var(--color-fg)]"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
        ))}
      </div>
      {editing ? null : (
        <Button
          variant="ghost"
          size="icon"
          tooltip="Edit (E)"
          aria-label="Edit"
          aria-keyshortcuts="E"
          aria-hidden={!frameReady || undefined}
          className={cn("sm:hidden", shown)}
          onClick={() => void setEditing(true)}
        >
          <TextCursor className="h-4 w-4" />
        </Button>
      )}
    </>
  );
}
