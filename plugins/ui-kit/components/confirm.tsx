/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: a confirmation step for destructive or disruptive work. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";

export function ConfirmAction(
  {
    trigger,
    title,
    description,
    confirmLabel = "Confirm",
    destructive = false,
    onConfirm,
  }: {
    trigger: React.ReactElement;
    title: string;
    description?: React.ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
    /** Resolve true to close; false keeps the dialog open (e.g. on failure). */
    onConfirm(): Promise<boolean> | boolean;
  },
): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending.current) {
          setError("");
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              if (pending.current) return;
              pending.current = true;
              setBusy(true);
              setError("");
              try {
                if (await onConfirm()) setOpen(false);
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              } finally {
                pending.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { Button } from "./button.tsx";
