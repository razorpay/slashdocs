import * as React from "react";
import * as Primitive from "@radix-ui/react-tooltip";

const HasTooltipProvider = React.createContext(false);

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <HasTooltipProvider.Provider value={true}>
      {/* A tooltip holds only a label. It closes when the pointer leaves its
          trigger, also when the pointer goes into the document frame, where
          the app gets no more pointer events. */}
      <Primitive.Provider
        delayDuration={500}
        skipDelayDuration={0}
        disableHoverableContent
      >
        {children}
      </Primitive.Provider>
    </HasTooltipProvider.Provider>
  );
}

// Only focus that the Tab key moves opens a tooltip. A dialog or menu moves
// the focus to its first control when it opens, and back to its trigger when
// it closes, and a tooltip then would cover the page.
let tabbed = false;
window.addEventListener("keydown", (e) => (tabbed = e.key === "Tab"), true);
window.addEventListener("pointerdown", () => (tabbed = false), true);
function openOnTabFocus(event: React.FocusEvent<HTMLElement>) {
  if (!tabbed) event.preventDefault();
}

// A help trigger, such as "Who can approve?", also toggles its tooltip on a
// click or a tap, because a touch screen has no hover. Radix closes a tooltip
// on a press of its trigger, so the trigger keeps the press for itself. Help
// is longer than a label, and it sits at the end of a line of hint text, over
// the controls below. Thus it opens above its trigger, and a press on it
// closes it, as a press outside does.
export function Tooltip({
  label,
  children,
  delayDuration,
  help = false,
}: {
  label: React.ReactNode;
  children: React.ReactElement<{ title?: string; disabled?: boolean }>;
  delayDuration?: number;
  help?: boolean;
}) {
  const hasProvider = React.useContext(HasTooltipProvider);
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const toggle = help && {
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      setOpen((o) => !o);
    },
  };
  // Native titles otherwise appear on top of the custom tooltip after a delay.
  const child = React.cloneElement(children, { title: undefined });
  const content = (
    <Primitive.Root open={open} onOpenChange={setOpen} delayDuration={delayDuration}>
      <Primitive.Trigger ref={trigger} asChild onFocus={openOnTabFocus} {...toggle}>
        {children.props.disabled ? (
          <span className="inline-flex shrink-0">{child}</span>
        ) : (
          child
        )}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={help ? "top" : "bottom"}
          sideOffset={6}
          collisionPadding={8}
          // A press of the trigger is the trigger's own, not a press outside.
          onPointerDownOutside={(e) => {
            if (trigger.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onPointerDown={help ? () => setOpen(false) : undefined}
          className="icon-tooltip z-[200] max-w-64 rounded-md bg-[#16191d] px-2.5 py-1.5 text-xs font-medium leading-snug text-white shadow-[var(--shadow-pop)] dark:bg-[#2b2e33]"
        >
          {label}
          <Primitive.Arrow
            className="fill-[#16191d] dark:fill-[#2b2e33]"
            width={8}
            height={4}
          />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
  // Standalone controls (including component previews) also work without the app shell.
  return hasProvider ? content : <TooltipProvider>{content}</TooltipProvider>;
}
