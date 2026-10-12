import { useCallback, useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import {
  downloadFilename,
  MAX_EXPORT_BYTES,
  MAX_PRINT_CHARACTERS,
  openPrintPreview,
} from "@/lib/document-export";
import { randomId } from "@/lib/uuid";

export function useDocumentExport(
  frame: RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  ready: boolean,
  register: (print: (() => void) | null) => void,
) {
  const pending = useRef<{
    id: string;
    preview: ReturnType<typeof openPrintPreview>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const lastDocumentAction = useRef(-Infinity);
  const print = useCallback(() => {
    if (!origin || !ready || !frame.current?.contentWindow) {
      toast.error("Wait for the document to finish loading before printing.");
      return;
    }
    if (pending.current) return;
    try {
      const preview = openPrintPreview();
      const id = randomId();
      const timer = setTimeout(() => {
        if (pending.current?.id !== id) return;
        preview.close();
        pending.current = null;
        frame.current?.contentWindow?.postMessage(
          { type: "slashdocs:print-finished" },
          origin,
        );
        toast.error(
          "Could not prepare the document. Please reload and try printing again.",
        );
      }, 5000);
      pending.current = { id, preview, timer };
      frame.current.contentWindow.postMessage(
        { type: "slashdocs:print-snapshot", requestId: id },
        origin,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open print preview.",
      );
    }
  }, [frame, origin, ready]);

  useEffect(() => {
    register(print);
    return () => register(null);
  }, [print, register]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        !origin ||
        event.origin !== origin ||
        event.source !== frame.current?.contentWindow ||
        !ready
      )
        return;
      const data = event.data;
      if (data?.type === "slashdocs:print-snapshot-result") {
        const current = pending.current;
        if (!current || current.id !== data.requestId) return;
        clearTimeout(current.timer);
        pending.current = null;
        const finish = () =>
          frame.current?.contentWindow?.postMessage(
            { type: "slashdocs:print-finished" },
            origin,
          );
        try {
          if (typeof data.html !== "string" || data.html.length > MAX_PRINT_CHARACTERS)
            throw new Error("Invalid print snapshot");
          current.preview.show(
            data.html,
            typeof data.title === "string" ? data.title : "Document",
            finish,
          );
        } catch {
          current.preview.close();
          finish();
          toast.error("Could not prepare this document for printing.");
        }
        return;
      }
      if (
        data?.type !== "slashdocs:print-request" &&
        data?.type !== "slashdocs:download-request"
      )
        return;
      const reply = (ok: boolean) =>
        frame.current?.contentWindow?.postMessage(
          { type: "slashdocs:export-response", requestId: data.requestId, ok },
          origin,
        );
      // Check browser-owned activation in the trusted parent, not a boolean
      // claimed by untrusted HTML. Bound repeats within one activation window.
      if (
        !navigator.userActivation?.isActive ||
        performance.now() - lastDocumentAction.current < 5000
      ) {
        reply(false);
        return;
      }
      lastDocumentAction.current = performance.now();
      if (data.type === "slashdocs:print-request") {
        print();
        reply(true);
        return;
      }
      try {
        if (!(data.blob instanceof Blob) || data.blob.size > MAX_EXPORT_BYTES)
          throw new Error("Invalid download");
        const filename = downloadFilename(data.filename);
        const url = URL.createObjectURL(data.blob);
        const link = document.createElement("a");
        link.download = filename;
        link.href = url;
        link.rel = "noopener";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        reply(true);
      } catch {
        reply(false);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.preview.close();
        pending.current = null;
      }
    };
  }, [frame, origin, ready, print]);
}
