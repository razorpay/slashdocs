import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { DropdownItem } from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HtmlFileInput } from "@/components/ui/upload";
import { DraftNotice } from "@/components/draft-notice";
import { api } from "@/api";
import { useEditDraft } from "@/lib/edit-drafts";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";

// The menu item only asks for the dialog to open. The dialog itself is
// rendered by the page, outside the dropdown: a dropdown closes whenever the
// window loses focus (the OS file picker does exactly that), and anything
// rendered inside it unmounts with it.
export function UploadBackupMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect}>
      <Upload className="h-4 w-4" /> Upload an HTML file
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload an HTML file</DialogTitle>
          <DialogDescription>
            Agents normally publish via the CLI. Use this only as a manual fallback.
          </DialogDescription>
        </DialogHeader>
        <UploadBackupForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// The form mounts each time the dialog opens. The typed title is a draft
// (`upload-title`) that Esc, a click outside, a failure and a reload keep,
// and Cancel discards. A file cannot outlive the page, so a title that came
// back asks for its file again. An upload that ends after Cancel names its
// document in a toast, but does not open it.
function UploadBackupForm({ onClose }: { onClose: () => void }) {
  const q = useQueryClient();
  const nav = useNavigate();
  const typed = useEditDraft("upload-title", "");
  const [file, setFile] = useState<File | null>(null);
  // The title that a file gives itself, once it is read. It shows as the
  // placeholder, so that it never takes the place of typed words, and it
  // counts only for its own file.
  const [found, setFound] = useState<{ file: File; title: string }>();
  const title = typed.value.trim() || (found?.file === file && found.title) || "";
  const m = useMutation({
    mutationFn: ({ title, file }: { title: string; file: File }) =>
      api.createDocument(title, file),
    onSuccess: (r, { title }) => {
      typed.sent(title);
      q.invalidateQueries({ queryKey: queryKeys.documents() });
      if (r.default_grant) {
        const verb =
          r.default_grant.role === "editor"
            ? "read, comment on and edit"
            : r.default_grant.role === "commenter"
              ? "read and comment on"
              : "read";
        toast.info(
          `Uploaded “${title}” — shared by default: everyone on this server can ${verb} this document. Manage access from the document's share menu.`,
          { duration: 8000 },
        );
      } else {
        toast.success(`Uploaded “${title}”.`);
      }
    },
    onError: (e) => toast.error(errorMessage(e, "Upload failed")),
  });
  const pick = (next: File | null) => {
    setFile(next);
    if (next) void htmlTitle(next).then((title) => setFound({ file: next, title }));
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !m.isPending)
          m.mutate(
            { title: title || file.name, file },
            {
              onSuccess: (r) => {
                onClose();
                nav(`/app/d/${r.id}`);
              },
            },
          );
      }}
    >
      <Field label="Title">
        <Input
          placeholder={title || file?.name || "Untitled"}
          value={typed.value}
          onChange={(e) => typed.setValue(e.target.value)}
        />
      </Field>
      <DraftNotice
        draft={typed}
        cameBack="Your title from earlier came back. Choose the file again."
      />
      <HtmlFileInput file={file} onFile={pick} />
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            typed.discard();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!file} busy={m.isPending}>
          Upload
        </Button>
      </DialogFooter>
    </form>
  );
}

// The title of an HTML file: its <title>, or else its first <h1>.
async function htmlTitle(file: File) {
  const doc = new DOMParser().parseFromString(await file.text(), "text/html");
  const h1 = doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ");
  return (doc.title || h1 || "").trim();
}
