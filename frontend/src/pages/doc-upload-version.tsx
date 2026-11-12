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
import { Notice, NoticeAction } from "@/components/ui/notice";
import { api, APIError, type Version } from "@/api";
import { useEditDraft } from "@/lib/edit-drafts";
import type { ShowSaved } from "./use-show-saved";
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

// A state of the document: a version, and the seq of the document in it
// when people can type in the version.
type Base = { version: string; seq?: number };

export function UploadVersionSheet({
  open,
  onOpenChange,
  ...form
}: {
  docId: string;
  // The state of the document that the upload replaces, as a push names its
  // pull: the version and the seq that the page showed when the form opened.
  // The page follows the text that other people type after it, but the file
  // does not have that text.
  base: Base;
  // The newest state of the document that the page knows. The uploader
  // replaces it when they choose to replace the text of other people, and
  // the refusal of the server names no newer state.
  live: Base;
  // useShowSaved of the page, which stays while the sheet comes and goes.
  showSaved?: ShowSaved;
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
// document (`version-summary:<docId>`). When the upload changes text that
// other people changed after the base, the server keeps their text and
// refuses the upload, and the form offers to replace the live document. An
// upload that ends after the sheet closed still says so, and does not close
// or clear a later form.
function UploadVersionForm({
  docId,
  base,
  live,
  showSaved,
  onClose,
}: {
  docId: string;
  base: Base;
  live: Base;
  showSaved?: ShowSaved;
  onClose: () => void;
}) {
  const q = useQueryClient();
  const summary = useEditDraft(`version-summary:${docId}`, docId);
  const [file, setFile] = useState<File | null>(null);
  // The upload was refused, because the document changed after its base.
  // latest is the newest state that the refusal names.
  const [refused, setRefused] = useState<{ latest?: Base }>();
  const m = useMutation({
    mutationFn: (sent: {
      base: Base;
      summary: string;
      file: File;
      show?: (uploaded: Version) => void;
    }) => api.createVersion(docId, sent.base, sent.summary, sent.file),
    onMutate: () => setRefused(undefined),
    onSuccess: (uploaded, sent) => {
      summary.sent(sent.summary);
      // A file that is the document as it is makes no version.
      if (uploaded.unchanged)
        return void toast.info("The file is the same as the document.");
      sent.show?.(uploaded);
      toast.success("Uploaded. The previous content is in the history.");
      q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      q.invalidateQueries({ queryKey: queryKeys.document(docId) });
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    },
    // The server refuses an upload that changes text that people changed
    // after its base, and names the current state. It also refuses a base
    // that it no longer has, and names no state.
    onError: (e) => {
      const refused =
        e instanceof APIError && (e.code === "version_conflict" || e.code === "stale");
      if (!refused) return void toast.error(errorMessage(e, "Upload failed"));
      const { current_version_id: version, seq } = (e.details ?? {}) as {
        current_version_id?: string;
        seq?: number;
      };
      setRefused({ latest: version ? { version, seq } : undefined });
    },
  });
  const upload = (on: Base) => {
    if (file && !m.isPending)
      m.mutate(
        { base: on, summary: summary.value, file, show: showSaved?.() },
        { onSuccess: onClose },
      );
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        upload(base);
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
      />
      <HtmlFileInput file={file} onFile={setFile} />
      {refused ? (
        <Notice say="This document changed after you opened this form.">
          <NoticeAction onClick={() => upload(refused.latest ?? live)}>
            Replace anyway
          </NoticeAction>
        </Notice>
      ) : null}
      <Button type="submit" disabled={!file} busy={m.isPending}>
        Upload
      </Button>
    </form>
  );
}
