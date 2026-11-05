import * as React from "react";
import * as AD from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { useLayerFocus } from "./sheet";

export const AlertDialog = AD.Root;
export const AlertDialogTrigger = AD.Trigger;

export function AlertDialogContent({
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Content>) {
  return (
    <AD.Portal>
      <AD.Overlay className="sheet-overlay fixed inset-0 z-50 bg-[hsl(218_30%_12%/0.24)] backdrop-blur-[2px] dark:bg-black/60" />
      <AD.Content
        className={cn(
          "dialog-content fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-pop)] dark:border-transparent focus:outline-none",
          className,
        )}
        {...useLayerFocus({ onOpenAutoFocus, onCloseAutoFocus })}
        {...p}
      />
    </AD.Portal>
  );
}
export function AlertDialogTitle({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Title>) {
  return <AD.Title className={cn("text-lg font-semibold", className)} {...p} />;
}
export function AlertDialogDescription({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Description>) {
  return (
    <AD.Description
      className={cn("mt-1 text-sm text-[var(--color-fg-muted)]", className)}
      {...p}
    />
  );
}
export function AlertDialogFooter({
  className,
  ...p
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex justify-end gap-2", className)} {...p} />;
}
export function AlertDialogCancel({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Cancel>) {
  return (
    <AD.Cancel asChild>
      <Button variant="outline" className={className} {...p} />
    </AD.Cancel>
  );
}
export function AlertDialogAction({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Action> & {
  variant?: "primary" | "danger";
}) {
  const { variant = "primary", ...rest } = p;
  return (
    <AD.Action asChild>
      <Button variant={variant} className={className} {...rest} />
    </AD.Action>
  );
}
