import * as React from "react";
import { useRef, useState } from "react";
import { FileCode2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

// HTML-file picking primitives shared by the backup-document and new-version
// upload forms.
export function useStagedFile() {
  const [file, setFile] = useState<File | null>(null);
  return { file, setFile, reset: () => setFile(null) };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A file picker that looks like one: a real button, and the chosen file's name
// next to it. The native <input type="file"> stays in the DOM (visually hidden)
// so the browser's own picker and Playwright's setInputFiles keep working.
export function HtmlFileInput({
  file,
  onFile,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value"> & {
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-sm border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-2 py-1.5",
        className,
      )}
    >
      <input
        ref={input}
        type="file"
        accept=".html,text/html"
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0] || null);
          // Let the same file be picked again after it was removed.
          e.target.value = "";
        }}
        {...rest}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => input.current?.click()}
      >
        <FileCode2 className="h-3.5 w-3.5" />
        {file ? "Change file" : "Choose HTML file"}
      </Button>
      {file ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
            {file.name}
            <span className="ml-2 text-[var(--color-fg-muted)]">
              {formatSize(file.size)}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Remove file"
            onClick={() => onFile(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <span className="text-sm text-[var(--color-fg-muted)]">
          No file chosen. Only .html files are accepted.
        </span>
      )}
    </div>
  );
}
