import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";

// A small non-modal panel under its trigger, such as reading settings. It is
// a Radix dialog without a focus trap or overlay, so the page stays usable
// while it is open. Escape, a click outside, or focus leaving it close it.
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactElement;
  // The panel's accessible name.
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [place, setPlace] = React.useState<{ top: number; right: number }>();
  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPlace({ top: r.bottom + 6, right: window.innerWidth - r.right });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Trigger asChild ref={triggerRef}>
        {trigger}
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // The trigger toggles the panel itself; closing on its pointerdown
          // would reopen it on the click that follows.
          onInteractOutside={(e) => {
            if (triggerRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          style={{
            position: "fixed",
            top: place?.top ?? 0,
            right: Math.max(8, place?.right ?? 8),
          }}
          className={cn(
            "z-50 w-[min(22rem,calc(100vw-1rem))] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm shadow-[var(--shadow-pop)] focus:outline-none dark:border-[var(--color-surface-muted)]",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
