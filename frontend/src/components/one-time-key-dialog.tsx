import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { publicURL } from "@/lib/config";
import { useLastDefined, useWarnBeforeUnload } from "@/lib/hooks";
import { closeOneTimeKey, headlessCLI, useOneTimeKeys } from "@/lib/one-time-keys";

// OneTimeKeyDialog shows each key that came, the oldest first, on any page,
// with its bot and name. A key goes only when the reader copies it and
// closes it, or chooses to close it without a copy.
export function OneTimeKeyDialog() {
  const keys = useOneTimeKeys();
  const shown = useLastDefined(keys[0]);
  const [copied, setCopied] = useState<number>();
  const [asking, setAsking] = useState<number>();
  // A reload or a closed tab loses the keys, so the browser asks first.
  useWarnBeforeUnload(keys.length > 0);
  if (!shown) return null;
  const close = () =>
    copied === shown.id ? closeOneTimeKey(shown.id) : setAsking(shown.id);
  return (
    <Dialog open={!!keys[0]} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-all">
            {shown.keyName ? `New key for ${shown.bot}` : `Meet ${shown.bot}`}
          </DialogTitle>
          <DialogDescription>
            {shown.keyName
              ? "Agents that use this key act as this bot."
              : "Share docs with this address to let your bot read or edit them."}
            {keys.length > 1 && ` This is key 1 of ${keys.length} to copy.`}
          </DialogDescription>
        </DialogHeader>
        <CodeBlock wrap>{shown.bot}</CodeBlock>
        <div className="mt-5 rounded-sm border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3">
          <div className="mb-1 break-all text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
            {shown.keyName || "Bot key"}
          </div>
          <div className="mb-2 text-sm font-semibold text-[var(--color-warning)]">
            Copy this key now — you won't see it again.
          </div>
          <CodeBlock copy="always" wrap onCopied={() => setCopied(shown.id)}>
            {shown.token}
          </CodeBlock>
        </div>
        <div className="mb-1 mt-4 text-xs text-[var(--color-fg-muted)]">
          Use it with the CLI:
        </div>
        <CodeBlock copy="always" onCopied={() => setCopied(shown.id)}>
          {headlessCLI(publicURL(), shown.token)}
        </CodeBlock>
        {asking === shown.id ? (
          <div
            role="alert"
            className="enter mt-4 space-y-3 rounded-sm border border-[var(--color-danger)]/40 p-3 text-sm"
          >
            <p>
              Close without a copy? This key will not show again. If you lose it, revoke
              it on the Bots page and make a new one.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" autoFocus onClick={() => setAsking(undefined)}>
                Keep it open
              </Button>
              <Button variant="danger" onClick={() => closeOneTimeKey(shown.id)}>
                Close without a copy
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter>
            <Button onClick={close}>Done</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
