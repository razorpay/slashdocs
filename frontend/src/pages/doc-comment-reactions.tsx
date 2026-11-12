import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SmilePlus } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  REACTION_EMOJI,
  type Comment,
  type ReactionEmoji,
  type Principal,
} from "@/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { useDoc } from "./doc-context";

// Keep readable names separate from the API's stable reaction slugs.
const REACTIONS: Record<string, { glyph: string; label: string }> = {
  "+1": { glyph: "👍", label: "Thumbs up" },
  "-1": { glyph: "👎", label: "Thumbs down" },
  laugh: { glyph: "😄", label: "Laugh" },
  hooray: { glyph: "🎉", label: "Celebrate" },
  confused: { glyph: "😕", label: "Confused" },
  heart: { glyph: "❤️", label: "Love" },
  rocket: { glyph: "🚀", label: "Rocket" },
  eyes: { glyph: "👀", label: "Eyes" },
  plus: { glyph: "➕", label: "Plus one" },
} satisfies Record<ReactionEmoji, { glyph: string; label: string }>;

const feedback =
  "transition-[background-color,color,box-shadow,transform] duration-150 ease-out motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]";

export function ReactionBar({
  c,
  docId,
  children,
}: {
  c: Comment;
  docId: string;
  children?: ReactNode;
}) {
  const q = useQueryClient();
  const { principal, signIn } = useDoc();
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const interactedOutside = useRef(false);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const toggle = useMutation({
    mutationFn: ({ emoji, reacted }: { emoji: string; reacted: boolean }) =>
      api.setCommentReaction(docId, c.id, emoji, reacted),
    onSuccess: async (_, { emoji, reacted }) => {
      setAnnouncement(
        `${REACTIONS[emoji]?.label || emoji} reaction ${reacted ? "added" : "removed"}`,
      );
      await q.invalidateQueries({ queryKey: queryKeys.comments(docId) });
    },
    onError: (e) => {
      setAnnouncement("Reaction failed. Please try again.");
      toast.error(errorMessage(e, "Reaction failed"));
    },
  });
  const saved = c.reactions || [];
  const pending = toggle.isPending ? toggle.variables : undefined;
  // Overlay only this comment while saving. Refetched data can already contain
  // the change, so compare the selected state before adjusting the count.
  const reactions = saved.map((r) =>
    pending?.emoji === r.emoji && pending.reacted !== r.reacted
      ? {
          ...r,
          reacted: pending.reacted,
          count: r.count + (pending.reacted ? 1 : -1),
          reactors:
            r.reactors && principal
              ? [
                  ...r.reactors.filter((p) => !samePrincipal(p, principal)),
                  ...(pending.reacted ? [principal] : []),
                ]
              : r.reactors,
        }
      : r,
  );
  if (pending?.reacted && !saved.some((r) => r.emoji === pending.emoji)) {
    reactions.push({
      emoji: pending.emoji,
      count: 1,
      reacted: true,
      reactors: principal ? [principal] : undefined,
    });
  }
  const react = (emoji: string, reacted: boolean) => {
    if (signIn) return signIn();
    if (toggle.isPending) return;
    setPicking(false);
    setAnnouncement("");
    // A last-reaction chip disappears immediately; keep keyboard focus nearby.
    if (!reacted && saved.find((r) => r.emoji === emoji)?.count === 1) {
      trigger.current?.focus({ preventScroll: true });
    }
    toggle.mutate({ emoji, reacted });
  };
  const selected = preview && reactions.some((r) => r.emoji === preview && r.reacted);

  return (
    <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-1">
        {reactions
          .filter((r) => r.count > 0)
          .map((r) => {
            const { glyph, label } = REACTIONS[r.emoji] || {
              glyph: r.emoji,
              label: r.emoji,
            };
            return (
              <Tooltip
                key={r.emoji}
                delayDuration={0}
                label={
                  r.reactors?.length ? (
                    <ReactionTooltip reactors={r.reactors} />
                  ) : (
                    `${r.reacted ? "Remove" : "Add"} ${label.toLowerCase()} reaction`
                  )
                }
              >
                <button
                  type="button"
                  aria-pressed={r.reacted}
                  aria-disabled={toggle.isPending}
                  aria-label={`${label}, ${r.count} ${r.count === 1 ? "reaction" : "reactions"}${r.reacted ? ", including you" : ""}`}
                  onClick={() => react(r.emoji, !r.reacted)}
                  className={cn(
                    "group/sticker inline-flex h-10 min-w-10 items-center justify-center rounded-md text-[11px] font-medium",
                    feedback,
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-md px-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.08)] ring-1 ring-inset transition-[background-color,box-shadow] duration-150",
                      r.reacted
                        ? "bg-amber-100 text-amber-900 ring-amber-300/70 group-hover/sticker:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-600/50 dark:group-hover/sticker:bg-amber-900/60"
                        : "bg-amber-50 text-amber-800 ring-amber-200/70 group-hover/sticker:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800/50 dark:group-hover/sticker:bg-amber-900/40",
                    )}
                  >
                    <span aria-hidden="true" className="text-[13px] leading-none">
                      {glyph}
                    </span>
                    <span className="min-w-[1ch] tabular-nums">{r.count}</span>
                  </span>
                </button>
              </Tooltip>
            );
          })}
      </div>
      <div className="flex items-center justify-between gap-1">
        <Menu.Root
          modal={false}
          open={picking}
          onOpenChange={(open) => {
            if (open && signIn) return signIn();
            if (open && toggle.isPending) return;
            if (open) interactedOutside.current = false;
            setPicking(open);
            setPreview(undefined);
          }}
        >
          <Menu.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              ref={trigger}
              type="button"
              aria-label="Add reaction"
              title="Add reaction"
              aria-disabled={toggle.isPending}
              className={cn(
                "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] data-[state=open]:bg-[var(--color-accent)]/10 data-[state=open]:text-[var(--color-accent)] aria-disabled:cursor-wait",
                feedback,
              )}
            >
              <SmilePlus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={12}
              loop
              aria-label="Choose a reaction"
              onInteractOutside={() => {
                interactedOutside.current = true;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (!interactedOutside.current)
                  trigger.current?.focus({ preventScroll: true });
              }}
              className="comment-reaction-picker z-50 w-[172px] rounded-2xl bg-[var(--color-surface)] p-2 text-[var(--color-fg)] shadow-[0_0_0_1px_var(--color-border),0_4px_8px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.12)] outline-none"
              onKeyDownCapture={(event) => {
                const step = {
                  ArrowRight: 1,
                  ArrowLeft: -1,
                  ArrowDown: 3,
                  ArrowUp: -3,
                }[event.key];
                if (!step) return;
                const index = items.current.findIndex(
                  (item) => item === document.activeElement,
                );
                if (index < 0) return;
                event.preventDefault();
                event.stopPropagation();
                items.current[
                  (index + step + REACTION_EMOJI.length) % REACTION_EMOJI.length
                ]?.focus({ preventScroll: true });
              }}
            >
              <Menu.Label className="px-1 pb-2 pt-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
                Add a reaction
              </Menu.Label>
              <div className="grid grid-cols-3 gap-1">
                {REACTION_EMOJI.map((emoji, index) => {
                  const reacted = reactions.some((r) => r.emoji === emoji && r.reacted);
                  return (
                    <Menu.CheckboxItem
                      key={emoji}
                      ref={(node) => {
                        items.current[index] = node;
                      }}
                      checked={reacted}
                      aria-label={REACTIONS[emoji].label}
                      textValue={REACTIONS[emoji].label}
                      onFocus={() => setPreview(emoji)}
                      onPointerMove={() => setPreview(emoji)}
                      onCheckedChange={() => react(emoji, !reacted)}
                      className={cn(
                        "relative flex h-12 cursor-pointer select-none items-center justify-center rounded-lg text-[23px] outline-none transition-[background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96] data-[highlighted]:bg-[var(--color-surface-muted)] data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-[var(--color-border-strong)]",
                        reacted && "bg-[var(--color-accent)]/10",
                      )}
                    >
                      <span aria-hidden="true">{REACTIONS[emoji].glyph}</span>
                      {reacted && (
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 h-1 w-1 rounded-full bg-[var(--color-accent)]"
                        />
                      )}
                    </Menu.CheckboxItem>
                  );
                })}
              </div>
              <div
                aria-hidden="true"
                className="mt-2 truncate border-t border-[var(--color-border)] px-1 pt-2 pb-1 text-center text-[11px] text-[var(--color-fg-muted)]"
              >
                {preview
                  ? `${selected ? "Remove " : ""}${REACTIONS[preview].label}`
                  : "Pick your reaction"}
              </div>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <div className="ml-auto flex shrink-0 items-center">{children}</div>
      </div>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

export function ReactionTooltip({ reactors }: { reactors: Principal[] }) {
  return (
    <div className="min-w-28 py-0.5">
      <ul
        className="max-h-48 space-y-1.5 overflow-y-auto overscroll-contain"
        aria-label="Reacted by"
      >
        {reactors.map((reactor) => (
          <li
            key={`${reactor.type}:${reactor.id}`}
            className="[overflow-wrap:anywhere]"
          >
            {reactor.name?.trim() || reactor.email?.trim() || "Deleted account"}
          </li>
        ))}
      </ul>
    </div>
  );
}
