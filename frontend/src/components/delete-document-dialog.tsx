import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Delete-document confirmation shared by the documents table row and the
// document toolbar dropdown. Pass `trigger` to let a button open it, or
// `open`/`onOpenChange` to control it from outside. A dialog launched from a
// dropdown menu must use the controlled form and be rendered outside the
// menu: menus close when the window loses focus and unmount their contents.
export function DeleteDocumentDialog({
  title,
  trigger,
  open,
  onOpenChange,
  onConfirm,
  description = "This permanently removes the document, all versions, and all comments. This cannot be undone.",
}: {
  title: string;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm: () => void;
  description?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
