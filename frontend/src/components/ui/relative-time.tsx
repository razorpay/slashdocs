import { useSyncExternalStore } from "react";
import { formatRelative, formatTimestamp } from "@/lib/format-date";
import { Tooltip } from "./tooltip";

// One clock for every relative time on the page, ticking once a minute, so
// "just now" becomes "1 minute ago" without each label keeping a timer.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const getNow = () => now;

// The time of the shared clock, which changes once a minute. A label that
// shows a time left or gone reads it, so that it draws again when the text
// can change.
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

// RelativeTime shows when something happened in words ("2 hours ago"), with
// the exact date and time on hover and for assistive tech.
export function RelativeTime({ iso, prefix }: { iso?: string; prefix?: string }) {
  const clock = useMinuteClock();
  const relative = formatRelative(iso, Math.max(clock, Date.now()));
  if (!relative) return null;
  const exact = formatTimestamp(iso);
  return (
    <Tooltip label={exact} delayDuration={300}>
      <time
        dateTime={iso}
        aria-label={prefix ? `${prefix} ${exact}` : exact}
        className="cursor-default"
      >
        {prefix ? `${prefix} ${relative}` : relative}
      </time>
    </Tooltip>
  );
}
