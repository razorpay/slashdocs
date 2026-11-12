import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownItem } from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HtmlFileInput, useStagedFile } from "@/components/ui/upload";
import { api } from "@/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";

// The menu item only asks for the dialog to open. The dialog itself is
// rendered by the page, outside the dropdown: a dropdown closes whenever the
// window loses focus (the OS file picker does exactly that), and anything
// rendered inside it unmounts with it.
export function UploadBackupMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect}>
      <Upload className="h-4 w-4" /> Upload HTML (backup)
    </DropdownItem>
  );
}

export function UploadBackupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const q = useQueryClient();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const { file, setFile, reset } = useStagedFile();
  const m = useMutation({
    mutationFn: () => api.createDocument(title || file?.name || "Untitled", file!),
    onSuccess: (r) => {
      q.invalidateQueries({ queryKey: queryKeys.documents() });
      if (r.default_grant) {
        const verb =
          r.default_grant.role === "editor"
            ? "read, comment on and edit"
            : r.default_grant.role === "commenter"
              ? "read and comment on"
              : "read";
        toast.info(
          `Uploaded — shared by default: everyone on this server can ${verb} this document. Manage access from the document's share menu.`,
          { duration: 8000 },
        );
      } else {
        toast.success("Document uploaded.");
      }
      onOpenChange(false);
      setTitle("");
      reset();
      nav(`/app/d/${r.id}`);
    },
    onError: (e) => toast.error(errorMessage(e, "Upload failed")),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload HTML (backup)</DialogTitle>
          <DialogDescription>
            Agents normally publish via the CLI. Use this only as a manual fallback.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) m.mutate();
          }}
        >
          <Input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <HtmlFileInput file={file} onFile={setFile} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!file || m.isPending}>
              {m.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
