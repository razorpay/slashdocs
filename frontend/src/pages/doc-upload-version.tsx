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
import { HtmlFileInput, useStagedFile } from "@/components/ui/upload";
import { api } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

// The menu item only asks for the sheet to open. The sheet is rendered by the
// toolbar outside the dropdown, because a dropdown closes when the window loses
// focus (opening the OS file picker does that) and unmounts everything inside.
export function UploadVersionMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownItem onSelect={onSelect} className="text-[var(--color-fg-muted)]">
      <Upload className="h-3.5 w-3.5" /> Upload new version (backup)
    </DropdownItem>
  );
}

export function UploadVersionSheet({
  docId,
  baseVersion,
  open,
  onOpenChange,
}: {
  docId: string;
  baseVersion: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const q = useQueryClient();
  const [summary, setSummary] = useState("");
  const [keepApprovals, setKeepApprovals] = useState(false);
  const { file, setFile, reset } = useStagedFile();
  const m = useMutation({
    mutationFn: () =>
      api.createVersion(docId, baseVersion, summary, file!, keepApprovals),
    onSuccess: () => {
      toast.success("Version uploaded.");
      onOpenChange(false);
      setSummary("");
      setKeepApprovals(false);
      reset();
      q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      q.invalidateQueries({ queryKey: queryKeys.document(docId) });
      q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
      q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    },
    onError: (e) => toast.error(errorMessage(e, "Upload failed")),
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Upload new version</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (file) m.mutate();
            }}
          >
            <Input
              placeholder="Change summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <HtmlFileInput file={file} onFile={setFile} />
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                <input
                  type="checkbox"
                  checked={keepApprovals}
                  onChange={(e) => setKeepApprovals(e.target.checked)}
                />
                Keep existing approvals
              </label>
              <p className="pl-6 text-[11px] text-[var(--color-fg-muted)]">
                Approvals are cleared when the content changes, so approvers review the
                new version. Keep them only for changes they do not need to see again.
              </p>
            </div>
            <Button type="submit" disabled={!file || m.isPending}>
              {m.isPending ? "Uploading…" : "Upload version"}
            </Button>
          </form>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
