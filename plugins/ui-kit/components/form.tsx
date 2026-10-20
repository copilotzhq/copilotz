/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: labelled fields, native select and checkbox. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useId } from "react";
import { cn } from "../utils.ts";

/** Label, control and optional hint; the control receives the generated id. */
export function Field(
  { label, hint, children, className }: {
    label: string;
    hint?: React.ReactNode;
    className?: string;
    children: (id: string) => React.ReactNode;
  },
): React.ReactElement {
  const id = useId();
  return (
    <div data-slot="field" className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children(id)}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function NativeSelect(
  { className, ...props }: React.ComponentProps<"select">,
): React.ReactElement {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input dark:bg-input/30 flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Checkbox(
  { label, className, ...props }:
    & Omit<React.ComponentProps<"input">, "type">
    & { label: React.ReactNode },
): React.ReactElement {
  return (
    <label
      data-slot="checkbox"
      className={cn("inline-flex items-center gap-2 text-sm", className)}
    >
      <input
        type="checkbox"
        className="accent-primary size-4 rounded border"
        {...props}
      />
      {label}
    </label>
  );
}
