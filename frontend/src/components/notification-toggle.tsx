import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { api, type NotificationPreferences } from "@/api";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { LoadErrorLine } from "@/components/error-state";
import { cn } from "@/lib/cn";

export function NotificationToggle({ documentId }: { documentId?: string }) {
  const qc = useQueryClient();
  const queryKey = ["notifications", documentId || "global"];
  const prefs = useQuery({
    queryKey,
    queryFn: () => api.notificationPreferences(documentId),
  });
  // The switch moves at once, and moves back if the server does not save it.
  // Writes go one after another, so that the last choice is the one saved.
  // Only the last write moves the switch back or reads the saved value.
  const last = () => qc.isMutating({ mutationKey: queryKey }) === 1;
  const update = useMutation({
    mutationKey: queryKey,
    scope: { id: queryKey.join(":") },
    mutationFn: (enabled: boolean) =>
      api.setNotificationPreferences(enabled, documentId),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NotificationPreferences>(queryKey);
      if (previous) qc.setQueryData(queryKey, { ...previous, enabled });
      return { previous };
    },
    onError: (e, _enabled, context) => {
      if (last()) qc.setQueryData(queryKey, context?.previous);
      toast.error(errorMessage(e, "Could not save notification settings"));
    },
    onSettled: () => last() && qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const enabled = prefs.data?.enabled ?? false;
  const label = documentId ? "Notifications for this document" : "Chat notifications";
  const disabled = prefs.isLoading || !!prefs.error;
  const title =
    documentId && enabled && !prefs.data?.effective_enabled
      ? "Notifications are disabled in your profile"
      : label;
  if (documentId) {
    // A switch that did not load does not guess: it loads again on a click.
    if (prefs.error)
      return (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notification settings did not load. Retry"
          disabled={prefs.isFetching}
          onClick={() => prefs.refetch()}
          className="h-10 w-10 shrink-0 text-[var(--color-fg-muted)]"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      );
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
          <LoadErrorLine query={prefs} className="mt-2">
            Could not load your notification settings.
          </LoadErrorLine>
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
            "flex h-6 w-11 items-center rounded-full p-0.5 transition-colors duration-150 ease-out motion-reduce:transition-none",
            enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
          )}
        >
          <span
            className={cn(
              "h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none",
              enabled && "translate-x-5",
            )}
          />
        </span>
      </button>
    </div>
  );
}
