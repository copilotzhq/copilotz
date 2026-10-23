/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: notices, empty states and the copy-once field. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { cn } from "../utils.ts";

export function Notice(
  { tone = "info", title, children, action, className }: {
    tone?: "info" | "warning" | "error" | "success";
    title?: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
    className?: string;
  },
): React.ReactElement {
  const Icon = tone === "error"
    ? CircleAlert
    : tone === "warning"
    ? TriangleAlert
    : tone === "success"
    ? CircleCheck
    : Info;
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm",
        tone === "info" && "bg-muted/50",
        tone === "error" && "border-destructive/30 bg-destructive/5",
        tone === "warning" && "border-warning/35 bg-warning/5",
        tone === "success" && "border-success/35 bg-success/5",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "info" && "text-muted-foreground",
          tone === "error" && "text-destructive",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState(
  { title, children, action, icon, className }: {
    title: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
    icon?: React.ReactNode;
    className?: string;
  },
): React.ReactElement {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="bg-muted text-muted-foreground mb-1 flex size-10 items-center justify-center rounded-full [&_svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <div className="text-muted-foreground max-w-sm text-sm">{children}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
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
