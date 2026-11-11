import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { LoaderCircle } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

// Blade's button: raised primary and secondary shadows, and an 8px radius
// (12px when large). A disabled primary goes neutral, as Slash retunes it,
// because a faded blue reads as broken on a dark canvas.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-[background-color,color,opacity,transform,box-shadow] duration-150 ease-out active:scale-[0.96] disabled:pointer-events-none disabled:scale-100 disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-[var(--shadow-button-primary)] hover:bg-[var(--color-accent-strong)] disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-fg-muted)] disabled:opacity-100 disabled:shadow-[var(--shadow-button-secondary)]",
        secondary:
          "bg-[var(--color-surface-muted)] text-[var(--color-fg)] hover:bg-[var(--color-border)]",
        outline:
          "bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-button-secondary)] hover:bg-[var(--color-surface-muted)]",
        ghost: "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]",
        // A control on the app chrome, whose gray hides the ghost's fill. An
        // open menu or panel keeps the fill, as a pressed toggle.
        chrome:
          "text-[var(--color-fg)] hover:bg-[var(--color-highlight)] aria-expanded:bg-[var(--color-highlight)]",
        danger:
          "bg-[var(--color-danger)] text-[var(--color-danger-fg)] hover:opacity-90",
        link: "text-[var(--color-accent)] underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-9 px-4 text-sm",
        lg: "h-12 rounded-md px-5 text-base",
        icon: "h-9 w-9 touch:h-10 touch:w-10",
        "icon-sm": "size-8 rounded-[6px] touch:size-10",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  tooltip?: string | false;
  // A busy button waits for its action. It takes no second press, and after
  // a short wait a spinner takes the place of its label, at the same width.
  busy?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild, tooltip, title, busy, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const child =
      asChild &&
      React.isValidElement<Pick<ButtonProps, "title" | "aria-label">>(children)
        ? children
        : null;
    const label =
      tooltip === false
        ? undefined
        : tooltip ||
          title ||
          child?.props.title ||
          (size?.startsWith("icon")
            ? props["aria-label"] || child?.props["aria-label"]
            : undefined);
    const button = (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), busy && "relative", className)}
        {...props}
        disabled={props.disabled || busy}
        aria-busy={busy || undefined}
        title={label || tooltip === false ? undefined : title}
      >
        {child && (label || tooltip === false) ? (
          React.cloneElement(child, { title: undefined })
        ) : busy ? (
          <>
            <span className="busy-label inline-flex items-center gap-2">
              {children}
            </span>
            <LoaderCircle
              aria-hidden="true"
              className="busy-spinner absolute inset-0 m-auto h-4 w-4"
            />
          </>
        ) : (
          children
        )}
      </Comp>
    );
    return label ? <Tooltip label={label}>{button}</Tooltip> : button;
  },
);
Button.displayName = "Button";
export { buttonVariants };
