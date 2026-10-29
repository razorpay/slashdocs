import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function NotificationToggle({ documentId }: { documentId?: string }) {
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: ["notifications", documentId || "global"],
    queryFn: () => api.notificationPreferences(documentId),
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setNotificationPreferences(enabled, documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) =>
      toast.error(errorMessage(e, "Could not save notification settings")),
  });
  const enabled = prefs.data?.enabled ?? false;
  const label = documentId ? "Notifications for this document" : "Chat notifications";
  const disabled = prefs.isLoading || !!prefs.error || update.isPending;
  const title = prefs.error
    ? "Could not load notification settings"
    : documentId && enabled && !prefs.data?.effective_enabled
      ? "Notifications are disabled in your profile"
      : label;
  if (documentId) {
    const Icon = prefs.data?.effective_enabled ? Bell : BellOff;
    return (
      <Button
        variant="ghost"
        size="icon"
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => update.mutate(!enabled)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
      >
        <Icon className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-sm font-medium">Chat notifications</div>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Mentions and new comments on your documents. You can mute individual documents
          from their comments panel.
        </p>
        {prefs.error && (
          <p className="mt-1 text-sm text-[var(--color-danger)]">
            Could not load settings. Reload to try again.
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => update.mutate(!enabled)}
        className="flex h-10 w-12 shrink-0 items-center disabled:opacity-50"
      >
        <span
          className={cn(
            "flex h-6 w-11 items-center rounded-full p-0.5 transition-colors",
            enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
          )}
        >
          <span
            className={cn(
              "h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
              enabled && "translate-x-5",
            )}
          />
        </span>
      </button>
    </div>
  );
}
