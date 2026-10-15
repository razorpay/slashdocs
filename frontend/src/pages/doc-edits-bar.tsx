import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Textarea } from "@/components/ui/input";
import type { Version } from "@/api";
import { formattingOnly } from "@/lib/text-edits/apply";
import type { TextEditsController } from "./use-text-edits";

function clip(text: string, limit = 48) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// Unsaved text edits in the document bar: the list, Discard, and Save as version.
export function EditsBar({
  textEdits,
  versions,
}: {
  textEdits: TextEditsController;
  versions: Version[];
}) {
  const { edits, conflict, saving } = textEdits;
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  if (!edits.length) return null;
  const placed = edits.filter((edit) => !edit.failed).length;
  const conflictNumber = versions.find((v) => v.id === conflict)?.number;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Dropdown>
        <DropdownTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-[var(--color-fg-muted)]"
          >
            {edits.length} unsaved {edits.length === 1 ? "edit" : "edits"}
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownTrigger>
        <DropdownContent className="w-96 max-w-[calc(100vw-1rem)]">
          <DropdownLabel>Click an edit to remove it</DropdownLabel>
          {edits.map((edit) => (
            <DropdownItem
              key={edit.id}
              aria-label={
                formattingOnly(edit)
                  ? `Remove edit: formatted ${clip(edit.text)}`
                  : `Remove edit: ${clip(edit.originalText)} to ${clip(edit.text)}`
              }
              onSelect={() => textEdits.remove(edit.id)}
            >
              <span className="min-w-0 flex-1 text-sm">
                {formattingOnly(edit) ? (
                  <>
                    <span className="text-[var(--color-fg-muted)]">Formatted</span>{" "}
                    <span>{clip(edit.text)}</span>
                  </>
                ) : (
                  <>
                    <span className="text-[var(--color-fg-muted)] line-through">
                      {clip(edit.originalText) || "(empty)"}
                    </span>{" "}
                    → <span>{clip(edit.text) || "(empty)"}</span>
                  </>
                )}
                {edit.failed ? (
                  <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-300">
                    Not applied
                  </span>
                ) : null}
              </span>
              <X className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-muted)]" />
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>
      <Button variant="ghost" size="sm" onClick={textEdits.discard} disabled={saving}>
        Discard
      </Button>
      <Button
        size="sm"
        disabled={saving || !placed}
        onClick={() => {
          setSummary(textEdits.defaultSummary());
          setOpen(true);
        }}
      >
        Save as version
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Save edits as a new version</DialogTitle>
            <DialogDescription>
              {conflict
                ? "Someone published a newer version while you were editing."
                : "Comments carry over to the new version as they do for any upload."}
            </DialogDescription>
          </DialogHeader>
          {conflict ? (
            <p className="text-sm text-[var(--color-fg-muted)]">
              Re-apply your edits to the newer version, check them, and save again.
              Edits whose text is gone stay in the list as not applied.
            </p>
          ) : (
            <Textarea
              aria-label="Change summary"
              rows={Math.min(8, Math.max(3, summary.split("\n").length))}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          )}
          <DialogFooter>
            {conflict ? (
              <Button
                onClick={() => {
                  setOpen(false);
                  void textEdits.reapply();
                }}
              >
                Re-apply edits to{" "}
                {conflictNumber ? `v${conflictNumber}` : "the newer version"}
              </Button>
            ) : (
              <Button
                disabled={saving}
                onClick={() => {
                  void textEdits.save(summary).then((saved) => {
                    if (saved) setOpen(false);
                  });
                }}
              >
                {saving ? "Saving…" : "Save version"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
