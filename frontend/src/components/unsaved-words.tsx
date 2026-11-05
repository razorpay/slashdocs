import { useEffect } from "react";
import { toast } from "sonner";
import { copyWords } from "@/lib/comment-drafts";
import { useWarnBeforeUnload } from "@/lib/hooks";
import { readUnsavedWords, useUnsavedWords } from "@/lib/persistent-store";

const TOAST = "unsaved-words";

// UnsavedWords tells the reader when the browser refuses to keep their
// unsent words: they then live only in this tab. A message stays while they
// do, with a copy of them, and the browser asks before a reload or a close
// loses them.
export function UnsavedWords() {
  const unsaved = useUnsavedWords().length > 0;
  useWarnBeforeUnload(unsaved);
  useEffect(() => {
    if (!unsaved) return;
    toast.warning(
      "This browser does not let the app keep your drafts. They stay in this tab only, and a reload loses them.",
      {
        id: TOAST,
        duration: Infinity,
        dismissible: false,
        action: {
          label: "Copy my text",
          // The message stays after a copy, while the words still wait.
          onClick: (event) => {
            event.preventDefault();
            copyWords(readUnsavedWords().map((body) => ({ body })));
          },
        },
      },
    );
    return () => void toast.dismiss(TOAST);
  }, [unsaved]);
  return null;
}
