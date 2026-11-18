import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api";
import { ExpiryPicker } from "@/components/expiry-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/errors";
import { formatTimestamp, formatUntil } from "@/lib/format-date";
import { queryKeys } from "@/lib/queryKeys";

// The dialog in which the owner sets, changes or removes the expiry of a
// document. The page renders it outside the menu that opens it.
export function ExpiryDialog({
  docId,
  expiresAt,
  enabled,
  open,
  onOpenChange,
}: {
  docId: string;
  expiresAt?: string;
  // The server deletes documents now. Without it, a document keeps the
  // expiry that it has, and the owner can only remove it.
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Auto-delete</DialogTitle>
          <DialogDescription>
            {expiresAt
              ? `This document is deleted on ${formatTimestamp(expiresAt)}.`
              : "This document is kept until you delete it."}
          </DialogDescription>
        </DialogHeader>
        <ExpiryForm
          docId={docId}
          expiresAt={expiresAt}
          enabled={enabled}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// The form mounts each time the dialog opens. With an expiry, no period is
// picked until the owner picks one, and Keep then removes the expiry. Without
// one, Keep is the state of the document, and there is nothing to save.
function ExpiryForm({
  docId,
  expiresAt,
  enabled,
  onClose,
}: {
  docId: string;
  expiresAt?: string;
  enabled: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string | null>(expiresAt ? null : "");
  const save = useMutation({
    mutationFn: (period: string) => api.setDocumentExpiry(docId, period || null),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: queryKeys.document(docId) });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      // Folder listings hold the document too.
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      onClose();
      toast.success(
        doc.expires_at
          ? `This document is deleted ${formatUntil(doc.expires_at)}.`
          : "This document is kept.",
      );
    },
    onError: (e) => toast.error(errorMessage(e, "Could not change auto-delete.")),
  });
  const changed = choice !== null && (choice !== "" || !!expiresAt);
  if (!enabled)
    return (
      <>
        <p className="text-pretty text-sm text-[var(--color-fg-muted)]">
          Auto-delete is turned off on this server, so no document is deleted now. When
          it is turned on again, the server deletes this document, with its history and
          all comments. Keep the document to stop that.
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate("")} busy={save.isPending}>
            Keep document
          </Button>
        </DialogFooter>
      </>
    );
  return (
    <>
      <ExpiryPicker value={choice} onChange={setChoice} disabled={save.isPending} />
      <p className="mt-3 text-pretty text-sm text-[var(--color-fg-muted)]">
        Auto-delete removes the document, its history, and all comments. This cannot be
        undone.
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => choice !== null && save.mutate(choice)}
          disabled={!changed}
          busy={save.isPending}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
