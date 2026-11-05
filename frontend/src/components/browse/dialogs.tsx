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
import { DraftNotice } from "@/components/draft-notice";
import { api } from "@/api";
import { useEditDraft } from "@/lib/edit-drafts";
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

// The form mounts each time the dialog opens. The name is a draft of the
// parent (`folder-name:<parentId>`): Esc, a click outside and a reload keep
// it, and Cancel discards it. A folder made after Cancel still shows in a
// toast, and does not close or clear a later form.
function NewFolderForm({
  parentFolderId,
  onClose,
}: {
  parentFolderId?: string;
  onClose: () => void;
}) {
  const name = useEditDraft(`folder-name:${parentFolderId ?? ""}`, "");
  const title = name.value;
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (sent: string) => api.createFolder(sent, parentFolderId),
    onSuccess: (_, sent) => {
      name.sent(sent);
      toast.success(`Created folder “${sent}”.`);
      qc.invalidateQueries({ queryKey: queryKeys.folders(parentFolderId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Create failed")),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !create.isPending)
          create.mutate(title, { onSuccess: onClose });
      }}
    >
      <Input
        placeholder="Folder name"
        aria-label="Folder name"
        value={title}
        onChange={(e) => name.setValue(e.target.value)}
        autoFocus
      />
      <DraftNotice draft={name} cameBack="Your folder name from earlier came back." />
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            name.discard();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim()} busy={create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

// Renames a folder. The name is a draft of the folder (`folder-title:<id>`)
// that starts from its title. Esc, a click outside and a reload keep it, and
// Cancel discards it. If someone renames the folder while the form is open,
// the form keeps the reader's name and asks which one to use.
export function RenameFolderDialog({
  open,
  onOpenChange,
  ...folder
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
        </DialogHeader>
        <RenameFolderForm {...folder} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenameFolderForm({
  id,
  title,
  onClose,
}: {
  id: string;
  title: string;
  onClose: () => void;
}) {
  const name = useEditDraft(`folder-title:${id}`, title, title);
  const qc = useQueryClient();
  const rename = useMutation({
    mutationFn: (sent: string) => api.updateFolder(id, sent),
    onSuccess: (_, sent) => {
      name.sent(sent);
      qc.invalidateQueries({ queryKey: queryKeys.folder(id) });
      toast.success(`Renamed to “${sent}”.`);
    },
    onError: (e) => toast.error(errorMessage(e, "Rename failed")),
  });
  const next = name.value.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (next && !name.stale && !rename.isPending)
          rename.mutate(next, { onSuccess: onClose });
      }}
    >
      <Input
        aria-label="Folder name"
        value={name.value}
        onChange={(e) => name.setValue(e.target.value)}
        autoFocus
      />
      <DraftNotice
        draft={name}
        cameBack="Your folder name from earlier came back."
        stale={{
          say: "The folder was renamed elsewhere. It is now:",
          quote: title,
          take: "Use the new name",
          keep: "Keep mine",
        }}
      />
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            name.discard();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!next || name.stale} busy={rename.isPending}>
          Rename
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
