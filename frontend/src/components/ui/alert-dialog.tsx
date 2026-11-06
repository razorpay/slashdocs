import * as React from "react";
import * as AD from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const AlertDialog = AD.Root;
export const AlertDialogTrigger = AD.Trigger;

export function AlertDialogContent({
  className,
  ...p
}: React.ComponentPropsWithoutRef<typeof AD.Content>) {
  return (
    <AD.Portal>
      <AD.Overlay className="fixed inset-0 z-50 bg-[hsl(218_30%_12%/0.24)] backdrop-blur-[2px] dark:bg-black/60 transition-opacity duration-150 ease-out data-[state=closed]:opacity-0 data-[state=open]:opacity-100" />
      <AD.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-pop)] dark:border-transparent transition-[opacity,transform] duration-200 ease-out data-[state=closed]:-translate-y-[calc(50%-4px)] data-[state=open]:-translate-y-1/2 data-[state=closed]:scale-[0.98] data-[state=open]:scale-100 data-[state=closed]:opacity-0 data-[state=open]:opacity-100 focus:outline-none",
          className,
        )}
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
