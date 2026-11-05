import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";

const EDGE = 8;

// Where the panel goes: under its trigger, right edges aligned, and moved
// left or right so it keeps EDGE px from both sides of the screen. On a
// phone a trigger far from the right edge would otherwise push the panel
// off the left side.
export function panelPlace(
  trigger: { left: number; right: number; bottom: number },
  panelWidth: number,
  viewportWidth: number,
): { top: number; right: number } {
  const aligned = viewportWidth - trigger.right;
  const leftmost = viewportWidth - panelWidth - EDGE;
  return {
    top: trigger.bottom + 6,
    right: Math.max(EDGE, Math.min(aligned, leftmost)),
  };
}

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
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [place, setPlace] = React.useState<{ top: number; right: number }>();
  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      const width = panelRef.current?.offsetWidth ?? 0;
      if (r) setPlace(panelPlace(r, width, window.innerWidth));
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
          ref={panelRef}
          aria-describedby={undefined}
          // The trigger toggles the panel itself; closing on its pointerdown
          // would reopen it on the click that follows.
          onInteractOutside={(e) => {
            if (triggerRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          style={{
            position: "fixed",
            top: place?.top ?? 0,
            right: place?.right ?? EDGE,
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
