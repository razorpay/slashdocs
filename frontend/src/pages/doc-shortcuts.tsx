import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CHORD_KEYS } from "@/lib/esc-chord";

const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

// Every document-page shortcut. The Esc chords come from CHORD_KEYS, so a new
// chord shows here without an edit.
const SECTIONS: { title: string; rows: [keys: string[], label: string][] }[] = [
  {
    title: "Esc, then a letter",
    rows: CHORD_KEYS.map(({ key, hint }) => [
      ["Esc", key.toUpperCase()],
      hint[0].toUpperCase() + hint.slice(1),
    ]),
  },
  {
    title: "Reading",
    rows: [
      [["J"], "Scroll down"],
      [["K"], "Scroll up"],
      [["Ctrl", "D"], "Half a page down"],
      [["Ctrl", "U"], "Half a page up"],
      [["G", "G"], "Top"],
      [["Shift", "G"], "Bottom"],
    ],
  },
  {
    title: "Comments",
    rows: [
      [["C"], "Comment on the selected text"],
      [[MOD, "Enter"], "Post a comment"],
    ],
  },
  {
    title: "Cursors",
    rows: [[["/"], "Chat at your cursor"]],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Your mouse can take the day off.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
                {section.title}
              </h3>
              <dl className="space-y-1.5 text-sm">
                {section.rows.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-4">
                    <dt>{label}</dt>
                    <dd className="flex gap-1">
                      {keys.map((key, index) => (
                        <kbd
                          key={index}
                          className="min-w-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-center font-mono text-xs"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
