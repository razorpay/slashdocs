import { type KeyboardEvent } from "react";
import { STEPS, TRACK } from "@/components/ui/segmented";
import { EXPIRY_PRESETS } from "@/lib/expiry";
import { cn } from "@/lib/cn";

// The choices are in rows, so the arrows up and down move as left and right.
const KEYS: typeof STEPS = {
  ...STEPS,
  ArrowDown: STEPS.ArrowRight,
  ArrowUp: STEPS.ArrowLeft,
};

// ExpiryPicker is the choice of when a document is deleted: Keep, or a
// period from now. It is a radio group with one tab stop. The arrow keys,
// Home and End move to a radio and pick it. A null value checks none, as when
// the document has an expiry that no period stands for.
export function ExpiryPicker({
  value,
  onChange,
  disabled,
  allowed = () => true,
  labelledBy,
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  // Tells whether the person can pick a period. An editor cannot pick one
  // that deletes the document sooner. The keys pass over the others.
  allowed?: (value: string) => boolean;
  // The id of a visible label. Without one the group is named "Auto-delete".
  labelledBy?: string;
  className?: string;
}) {
  const picked = EXPIRY_PRESETS.findIndex((p) => p.value === value);
  // The one tab stop is the picked radio, or the first that the person can
  // pick: a radio that is off takes no focus.
  const stop =
    picked >= 0
      ? picked
      : Math.max(
          EXPIRY_PRESETS.findIndex((p) => allowed(p.value)),
          0,
        );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEYS[event.key];
    if (!step || disabled) return;
    event.preventDefault();
    const radios = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
    ];
    const at = radios.indexOf(event.target as HTMLElement);
    let next = step(at >= 0 ? at : Math.max(picked, 0), radios.length);
    // Home and End stop at the edge, so a walk from there goes inward.
    const inward =
      next === 0 ? 1 : next === radios.length - 1 ? -1 : next > at ? 1 : -1;
    for (let i = 0; i < radios.length && !allowed(EXPIRY_PRESETS[next].value); i++)
      next = (next + inward + radios.length) % radios.length;
    if (!allowed(EXPIRY_PRESETS[next].value)) return;
    onChange(EXPIRY_PRESETS[next].value);
    radios[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : "Auto-delete"}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      // Three in a row: six choices do not fit in one row of a dialog, and
      // a wrap would leave the last one alone.
      className={cn(TRACK, "grid grid-cols-3", className)}
    >
      {EXPIRY_PRESETS.map((preset, i) => (
        <button
          key={preset.value}
          type="button"
          role="radio"
          aria-checked={i === picked}
          tabIndex={i === stop ? 0 : -1}
          disabled={disabled || !allowed(preset.value)}
          onClick={() => onChange(preset.value)}
          className="flex h-8 flex-1 items-center justify-center whitespace-nowrap rounded-[6px] px-3 text-sm font-medium text-[var(--color-fg-muted)] transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:text-[var(--color-fg)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-[var(--color-surface)] aria-checked:text-[var(--color-fg)] aria-checked:shadow-[var(--shadow-border)] touch:h-10"
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
