import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";

// Creates a root folder, or a subfolder when `parentFolderId` is given.
export function NewFolderDialog({
  open,
  onOpenChange,
  parentFolderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentFolderId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentFolderId ? "New subfolder" : "New folder"}</DialogTitle>
        </DialogHeader>
        <NewFolderForm
          parentFolderId={parentFolderId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// The form mounts each time the dialog opens. A folder made after Cancel
// still shows in a toast, and does not close or clear a later form.
function NewFolderForm({
  parentFolderId,
  onClose,
}: {
  parentFolderId?: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (sent: string) => api.createFolder(sent, parentFolderId),
    onSuccess: (_, sent) => {
      toast.success(`Created folder “${sent}”.`);
      qc.invalidateQueries({ queryKey: queryKeys.folders(parentFolderId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Create failed")),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate(title, { onSuccess: onClose });
      }}
    >
      <Input
        placeholder="Folder name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <DialogFooter className="mt-4">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

// "Access may change" warning shown after a move whose permissions differ.
export function AccessWarningDialog({
  warning,
  onClose,
}: {
  warning: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!warning} onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Access may change</DialogTitle>
          <DialogDescription>{warning}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onClose()}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
