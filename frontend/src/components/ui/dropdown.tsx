import * as React from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/cn";

export const Dropdown = DM.Root;
export const DropdownTrigger = DM.Trigger;

export function DropdownContent({
  className,
  onCloseAutoFocus,
  ...p
}: React.ComponentPropsWithoutRef<typeof DM.Content>) {
  // Focus goes back to the trigger only when the keyboard closed the menu.
  // After a click, the returned focus opens the trigger's tooltip.
  const closedByPointer = React.useRef(false);
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={6}
        align="end"
        onPointerDownCapture={() => (closedByPointer.current = true)}
        onPointerDownOutside={() => (closedByPointer.current = true)}
        onKeyDownCapture={() => (closedByPointer.current = false)}
        onEscapeKeyDown={() => (closedByPointer.current = false)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (closedByPointer.current) event.preventDefault();
        }}
        className={cn(
          "z-50 min-w-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-pop)] dark:border-[var(--color-surface-muted)] transition-[opacity,transform] duration-150 ease-out data-[state=closed]:translate-y-1 data-[state=open]:translate-y-0 data-[state=closed]:scale-[0.98] data-[state=open]:scale-100 data-[state=closed]:opacity-0 data-[state=open]:opacity-100 focus:outline-none",
          className,
        )}
        {...p}
      />
    </DM.Portal>
  );
}
export function DropdownItem({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn(
        "flex min-h-10 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-[background-color,color] duration-150 ease-out data-[highlighted]:bg-[var(--color-surface-muted)]",
        className,
      )}
      {...p}
    />
  );
}
export function DropdownSeparator() {
  return <DM.Separator className="my-1 h-px bg-[var(--color-border)]" />;
}
export function DropdownLabel({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof DM.Label>) {
  return (
    <DM.Label
      className={cn(
        "px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]",
        className,
      )}
      {...p}
    />
  );
}
