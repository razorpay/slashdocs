import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/cn";
import {
  CHORD_KEYS,
  CHORD_WINDOW_MS,
  type ChordKey,
  type ChordState,
} from "@/lib/esc-chord";

// Keycast shows that Esc waits for a letter: the letters and what they do,
// and a line that runs out with the time to press one. After that time, a
// letter is a plain key again, so C places a comment instead of opening the
// comments. The keys and the legend sit on one dark surface, so that they
// read over any document, light or dark.
const SURFACE = "bg-neutral-700/95 text-white shadow-lg dark:bg-neutral-800/95";

export function Keycast({
  state,
  available,
  label,
}: {
  state: ChordState;
  available: ReadonlyArray<ChordKey>;
  label?: string;
}) {
  const visible = state.phase !== "idle";
  const resolvedKey = state.phase === "resolved" ? state.key : undefined;
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="keycast"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="pointer-events-none absolute bottom-6 left-5 z-30 select-none"
          aria-hidden="true"
        >
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 font-mono text-lg font-medium tracking-wide",
              SURFACE,
            )}
          >
            <span>ESC</span>
            {resolvedKey ? (
              <>
                <span className="text-white/50">+</span>
                <span>{resolvedKey.toUpperCase()}</span>
              </>
            ) : null}
          </div>
          {resolvedKey ? null : (
            <motion.div
              role="progressbar"
              aria-label="Time to press a letter"
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: CHORD_WINDOW_MS / 1000, ease: "linear" }}
              className="mt-1 h-0.5 origin-left rounded-full bg-[var(--color-fg-muted)] motion-reduce:hidden"
            />
          )}
          <div
            className={cn(
              "mt-1.5 w-fit rounded-lg px-2.5 py-1.5 text-xs text-white/75",
              SURFACE,
            )}
          >
            {resolvedKey
              ? label
              : CHORD_KEYS.filter((item) => available.includes(item.key)).map(
                  (item) => (
                    <span
                      key={item.key}
                      className="mr-3 inline-block whitespace-nowrap last:mr-0"
                    >
                      <kbd className="mr-1 rounded bg-white/15 px-1 font-mono font-medium text-white">
                        {item.key.toUpperCase()}
                      </kbd>
                      {item.hint}
                    </span>
                  ),
                )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
