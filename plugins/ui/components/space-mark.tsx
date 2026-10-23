/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Small identity marks for Spaces and conversations. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { Inbox } from "lucide-react";
import { cn, identityColor, initials } from "@copilotz/copilotz/web/kit";

/** A Space's colored monogram. */
export function SpaceMark(
  { id, name, size = "sm", className }: {
    id: string;
    name: string;
    size?: "sm" | "md" | "lg";
    className?: string;
  },
): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: identityColor(id) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        size === "sm" && "size-5 text-[9px]",
        size === "md" && "size-7 text-[11px]",
        size === "lg" && "size-10 rounded-lg text-sm",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** The mark of conversations in no Space: a quiet outline, the size of a Space's. */
export function NoSpaceMark(
  { className }: { className?: string },
): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "border-muted-foreground/35 text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-dashed",
        className,
      )}
    >
      <Inbox className="size-3" />
    </span>
  );
}

/** A conversation's muted monogram. */
export function ThreadMark(
  { title, className }: { title: string; className?: string },
): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-sidebar-accent text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-medium",
        className,
      )}
    >
      {initials(title)}
    </span>
  );
}

/** A Space's color dot, shown beside conversations grouped by date. */
export function SpaceDot(
  { id, name }: { id: string; name: string },
): React.ReactElement {
  return (
    <span
      role="img"
      aria-label={`In ${name}`}
      title={name}
      style={{ backgroundColor: identityColor(id) }}
      className="size-1.5 shrink-0 rounded-full"
    />
  );
}
