/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: notices, empty states and the copy-once field. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { cn } from "../utils.ts";

export function Notice(
  { tone = "info", title, children, action }: {
    tone?: "info" | "warning" | "error" | "success";
    title?: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
  },
): React.ReactElement {
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40 text-destructive",
        tone === "warning" && "border-amber-500/40",
        tone === "success" && "border-emerald-500/40",
      )}
    >
      <div className="grid gap-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState(
  { title, children, action }: {
    title: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
  },
): React.ReactElement {
  return (
    <div
      data-slot="empty-state"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center"
    >
      <p className="font-medium">{title}</p>
      {children && (
        <div className="text-muted-foreground max-w-sm text-sm">{children}</div>
      )}
      {action}
    </div>
  );
}

/** A read-only value with an injected clipboard capability; never persisted. */
export function CopyField(
  { label, value, copy }: {
    label: string;
    value: string;
    copy(text: string): Promise<void>;
  },
): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div data-slot="copy-field" className="flex gap-2">
      <Input aria-label={label} readOnly value={value} className="font-mono" />
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          copy(value).then(() => setCopied(value), () => setCopied(null))}
      >
        {copied === value ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
