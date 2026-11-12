import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

// Blade's button: raised primary and secondary shadows, an 8px radius (12px
// when large), and a soft 4px focus ring. A disabled primary goes neutral, as
// Slash retunes it, because a faded blue reads as broken on a dark canvas.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-[background-color,color,opacity,transform,box-shadow] duration-150 ease-out active:scale-[0.97] focus-visible:outline-4 focus-visible:outline-[color-mix(in_srgb,var(--color-accent)_24%,transparent)] disabled:pointer-events-none disabled:scale-100 disabled:opacity-50",
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
        danger:
          "bg-[var(--color-danger)] text-[var(--color-danger-fg)] hover:opacity-90",
        link: "text-[var(--color-accent)] underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-9 px-4 text-sm",
        lg: "h-12 rounded-md px-5 text-base",
        icon: "h-9 w-9",
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
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, tooltip, title, children, ...props }, ref) => {
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
          (size === "icon"
            ? props["aria-label"] || child?.props["aria-label"]
            : undefined);
    const button = (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
        title={label || tooltip === false ? undefined : title}
      >
        {child && (label || tooltip === false)
          ? React.cloneElement(child, { title: undefined })
          : children}
      </Comp>
    );
    return label ? <Tooltip label={label}>{button}</Tooltip> : button;
  },
);
Button.displayName = "Button";
export { buttonVariants };
