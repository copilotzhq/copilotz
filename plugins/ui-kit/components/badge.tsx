/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

const badgeVariants: (
  props?: {
    variant?:
      | "default"
      | "secondary"
      | "destructive"
      | "outline"
      | "soft"
      | "success"
      | "warning"
      | null;
    class?: never;
    className?: import("clsx").ClassValue;
  },
) => string = cva(
  "inline-flex items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:ring-ring/45 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive/12 text-destructive [a&]:hover:bg-destructive/20",
        outline:
          "text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        soft: "border-transparent bg-primary/10 text-primary",
        success: "border-transparent bg-success/12 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}:
  & React.ComponentProps<"span">
  & VariantProps<typeof badgeVariants>
  & { asChild?: boolean }): React.ReactElement | null {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
