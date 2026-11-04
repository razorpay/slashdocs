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
  const [title, setTitle] = useState("");
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createFolder(title, parentFolderId),
    onSuccess: () => {
      onOpenChange(false);
      setTitle("");
      qc.invalidateQueries({ queryKey: queryKeys.folders(parentFolderId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Create failed")),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentFolderId ? "New subfolder" : "New folder"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <Input
            placeholder="Folder name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
