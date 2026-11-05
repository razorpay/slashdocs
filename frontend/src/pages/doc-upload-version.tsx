import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownItem } from "@/components/ui/dropdown";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { HtmlFileInput } from "@/components/ui/upload";
import { DraftNotice } from "@/components/draft-notice";
import { api, type Version } from "@/api";
import { useEditDraft } from "@/lib/edit-drafts";
import { queryKeys } from "@/lib/queryKeys";

// The menu item only asks for the sheet to open. The sheet is rendered by the
// toolbar outside the dropdown, because a dropdown closes when the window loses
// focus (opening the OS file picker does that) and unmounts everything inside.
export function UploadVersionMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect}>
      <Upload className="h-4 w-4" /> Replace with an HTML file
    </DropdownItem>
  );
}

export function UploadVersionSheet({
  open,
  onOpenChange,
  ...form
}: {
  docId: string;
  baseVersion: string;
  onUploaded?: (uploaded: Version) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Replace with an HTML file</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <UploadVersionForm {...form} onClose={() => onOpenChange(false)} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

// The form mounts each time the sheet opens. Its summary is a draft of the
// document (`version-summary:<docId>`), written for the latest version when
// the form opened: the upload replaces that version only. If a new version
// comes first, the form says so, and the reader replaces the new version or
// discards the upload. An upload that ends after the sheet closed still says
// so, and does not close or clear a later form.
function UploadVersionForm({
  docId,
  baseVersion,
  onUploaded,
  onClose,
}: {
  docId: string;
  baseVersion: string;
  onUploaded?: (uploaded: Version) => void;
  onClose: () => void;
}) {
  const q = useQueryClient();
  const summary = useEditDraft(`version-summary:${docId}`, baseVersion);
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: (sent: { base: string; summary: string; file: File }) =>
      api.createVersion(docId, sent.base, sent.summary, sent.file),
    onSuccess: (uploaded, sent) => {
      summary.sent(sent.summary);
      onUploaded?.(uploaded);
      toast.success("Uploaded. The previous content is in the history.");
      q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      q.invalidateQueries({ queryKey: queryKeys.document(docId) });
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Upload failed")),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !summary.stale && !m.isPending)
          m.mutate(
            { base: summary.about, summary: summary.value, file },
            { onSuccess: onClose },
          );
      }}
    >
      <Input
        placeholder="Change summary"
        aria-label="Change summary"
        value={summary.value}
        onChange={(e) => summary.setValue(e.target.value)}
      />
      <DraftNotice
        draft={summary}
        cameBack="Your summary from earlier came back. Choose the file again."
        stale={{
          say: "A new version was published after you opened this form. The upload would replace it.",
          take: "Discard",
          keep: "Replace the new version",
          onTake: () => {
            summary.discard();
            onClose();
          },
        }}
      />
      <HtmlFileInput file={file} onFile={setFile} />
      <Button type="submit" disabled={!file || summary.stale} busy={m.isPending}>
        Upload
      </Button>
    </form>
  );
}
