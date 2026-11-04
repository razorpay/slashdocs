import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { openFocus, SheetHandle } from "./sheet";
import { Tooltip } from "./tooltip";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

// A dialog sits in the middle of the screen. With anchor "top", it sits at a
// fixed top instead, so content that grows, such as a list that loads, makes
// it longer at the bottom and does not move it. A narrow screen shows such a
// dialog as a sheet at the bottom, as the comment sheets are.
export function DialogContent({
  className,
  children,
  anchor = "center",
  onOpenAutoFocus,
  ...p
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  anchor?: "center" | "top";
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-50 bg-[hsl(218_30%_12%/0.24)] backdrop-blur-[2px] dark:bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          "dialog-content fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-pop)] dark:border-transparent focus:outline-none",
          anchor === "top" &&
            "dialog-sheet top-[12vh] translate-y-0 max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:rounded-b-none max-md:rounded-t-2xl max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:pt-0",
          className,
        )}
        onOpenAutoFocus={openFocus(onOpenAutoFocus)}
        {...p}
      >
        {anchor === "top" && <SheetHandle className="mb-4 md:hidden" />}
        {children}
        <Tooltip label="Close dialog">
          <DialogPrimitive.Close
            data-dialog-close
            aria-label="Close dialog"
            className="absolute right-3 top-[18px] inline-flex min-h-10 min-w-10 items-center justify-center rounded-md p-1 text-[var(--color-fg-muted)] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </Tooltip>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({
  className,
  ...p
}: React.HTMLAttributes<HTMLDivElement>) {
  // The close button sits on the title's line, so the title leaves it room.
  return <div className={cn("mb-4 space-y-1 pr-8", className)} {...p} />;
}
export function DialogTitle({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-balance text-lg font-semibold tracking-tight", className)}
      {...p}
    />
  );
}
export function DialogDescription({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-pretty text-sm text-[var(--color-fg-muted)]", className)}
      {...p}
    />
  );
}
export function DialogFooter({
  className,
  ...p
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex justify-end gap-2", className)} {...p} />;
}
