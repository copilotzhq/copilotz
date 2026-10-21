/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Transient notices in one polite live region. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { cn } from "@copilotz/copilotz/web/kit";

export type Toast = Readonly<{
  id: string;
  text: string;
  tone: "info" | "error";
}>;

function Item(
  { toast, onDismiss }: { toast: Toast; onDismiss(id: string): void },
): React.ReactElement {
  useEffect(() => {
    const timer = setTimeout(
      () => onDismiss(toast.id),
      toast.tone === "error" ? 8000 : 4000,
    );
    return () => clearTimeout(timer);
  }, [toast.id]);
  const Glyph = toast.tone === "error" ? CircleAlert : CircleCheck;
  return (
    <li
      className={cn(
        "bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-float",
        toast.tone === "error" && "border-destructive/30",
      )}
    >
      <Glyph
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          toast.tone === "error" ? "text-destructive" : "text-success",
        )}
      />
      <span className="min-w-0 flex-1">{toast.text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="text-muted-foreground hover:text-foreground -m-1 rounded p-1"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

export function Toaster(
  { toasts, onDismiss }: {
    toasts: readonly Toast[];
    onDismiss(id: string): void;
  },
): React.ReactElement {
  return (
    <ol
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] grid w-[min(24rem,calc(100vw-2rem))] gap-2 [&>*]:pointer-events-auto"
    >
      {toasts.map((toast) => (
        <Item key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </ol>
  );
}
