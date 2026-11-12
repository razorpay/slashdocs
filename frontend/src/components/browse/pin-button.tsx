import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useTogglePin, type ResourceType } from "./use-resource-actions";

export function PinButton({
  resourceType,
  resourceId,
  pinned,
  className,
}: {
  resourceType: ResourceType;
  resourceId: string;
  pinned?: boolean;
  className: string;
}) {
  const { isPinned, togglePin } = useTogglePin(resourceType, resourceId, pinned);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={isPinned ? "Unpin" : "Pin"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePin.mutate();
      }}
    >
      {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
    </Button>
  );
}

// PinnedMark shows that an item is pinned. It stays visible, unlike PinButton.
export function PinnedMark({ className }: { className?: string }) {
  return (
    <Pin
      role="img"
      aria-label="Pinned"
      className={cn("h-3 w-3 shrink-0 rotate-45 text-[var(--color-accent)]", className)}
    />
  );
}
