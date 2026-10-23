/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Kit extension: separator, keyboard hint, spinner and visually hidden text. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../utils.ts";

export function Separator(
  { className, orientation = "horizontal", decorative = true, ...props }:
    & React.ComponentProps<"div">
    & { orientation?: "horizontal" | "vertical"; decorative?: boolean },
): React.ReactElement {
  return (
    <div
      data-slot="separator"
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "bg-border shrink-0",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}

/** A keyboard shortcut hint, such as ⌘K. */
export function Kbd(
  { className, ...props }: React.ComponentProps<"kbd">,
): React.ReactElement {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-muted text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded border px-1 font-sans text-[11px] font-medium select-none",
        className,
      )}
      {...props}
    />
  );
}

/** An indeterminate progress indicator; label it when it stands alone. */
export function Spinner(
  { className, label }: { className?: string; label?: string },
): React.ReactElement {
  return (
    <LoaderCircle
      data-slot="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("size-4 animate-spin text-muted-foreground", className)}
    />
  );
}

export function VisuallyHidden(
  { children }: { children?: React.ReactNode },
): React.ReactElement {
  return <span className="sr-only">{children}</span>;
}
