import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Tooltip } from "./tooltip";
import { cn } from "@/lib/cn";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

// openFocus puts the focus of a dialog that opens on the dialog itself when
// its close button is its first control, so that it does not open with a
// ring on Close. Tab then goes to Close. Other dialogs focus their first
// control, as Radix does.
export function openFocus(onOpenAutoFocus?: (event: Event) => void) {
  return (event: Event) => {
    onOpenAutoFocus?.(event);
    const content = event.currentTarget as HTMLElement;
    const first = content.querySelector(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    if (event.defaultPrevented || !first?.hasAttribute("data-dialog-close")) return;
    event.preventDefault();
    content.focus();
  };
}

export function SheetContent({
  className,
  children,
  side = "right",
  onOpenAutoFocus,
  ...p
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  side?: "right" | "left";
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-50 bg-[hsl(218_30%_12%/0.24)] backdrop-blur-[2px] dark:bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 top-0 flex h-full w-full max-w-md flex-col border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-pop)] focus:outline-none",
          side === "right"
            ? "right-0 border-l sheet-right"
            : "left-0 border-r sheet-left",
          className,
        )}
        onOpenAutoFocus={openFocus(onOpenAutoFocus)}
        {...p}
      >
        {children}
        <Tooltip label="Close panel">
          <DialogPrimitive.Close
            data-dialog-close
            aria-label="Close panel"
            className="absolute right-2 top-0 inline-flex h-14 w-12 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </Tooltip>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
export function SheetHeader({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center px-6 h-14 pr-14 border-b border-[var(--color-border)]",
        className,
      )}
      {...p}
    />
  );
}
export function SheetTitle({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-balance text-base font-semibold", className)}
      {...p}
    />
  );
}
export function SheetBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 overflow-y-auto p-6", className)} {...p} />;
}

// The grab handle at the top of a bottom sheet, which shows that the panel is
// a sheet over the page.
export function SheetHandle({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--color-border-strong)]",
        className,
      )}
    />
  );
}
