/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Kit extension: a confirmation step for destructive or disruptive work. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useRef, useState } from "react";
import { Slot } from "@radix-ui/react-slot";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog.tsx";

/** A controlled confirmation dialog (use it where a trigger can't own the dialog, such as menus). */
export function ConfirmDialog(
  {
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = "Confirm",
    destructive = false,
    onConfirm,
  }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    title: string;
    description?: React.ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
    /** Resolve true to close; false keeps the dialog open (e.g. on failure). */
    onConfirm(): Promise<boolean> | boolean;
  },
): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending.current) {
          setError("");
          onOpenChange(next);
        }
      }}
    >
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error && <Notice tone="error" title="That didn't work">{error}
        </Notice>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
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
                if (await onConfirm()) onOpenChange(false);
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

/** A trigger that opens a confirmation dialog for destructive or disruptive work. */
export function ConfirmAction(
  {
    trigger,
    ...props
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
  return (
    <>
      <Slot aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {trigger}
      </Slot>
      <ConfirmDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}

import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";
import { Notice } from "./feedback.tsx";

/**
 * A dialog form with one submit path: Enter submits, the submit button shows
 * progress, a rejection stays open with its message, and dismissal is blocked
 * while pending. `onSubmit` resolves true (or nothing) to close.
 */
export function FormDialog(
  {
    open,
    onOpenChange,
    title,
    description,
    submitLabel = "Save",
    canSubmit = true,
    onSubmit,
    children,
  }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    title: string;
    description?: React.ReactNode;
    submitLabel?: string;
    canSubmit?: boolean;
    /** Resolve anything but `false` to close. */
    onSubmit(): unknown;
    children?: React.ReactNode;
  },
): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending.current) return;
        setError("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending.current || !canSubmit) return;
            pending.current = true;
            setBusy(true);
            setError("");
            try {
              if (await onSubmit() !== false) onOpenChange(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}
            </DialogDescription>}
          </DialogHeader>
          {children}
          {error && (
            <Notice tone="error" title="That didn't work">{error}</Notice>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !canSubmit}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one name-and-description editor (Spaces, resources, conversations). */
export function NameDescriptionDialog(
  {
    open,
    onOpenChange,
    title,
    description,
    initial = {},
    submitLabel = "Save",
    nameLabel = "Name",
    descriptionLabel = "Description",
    withDescription = true,
    onSubmit,
  }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    title: string;
    description?: React.ReactNode;
    initial?: { name?: string; description?: string };
    submitLabel?: string;
    nameLabel?: string;
    descriptionLabel?: string;
    withDescription?: boolean;
    /** Resolve anything but `false` to close. */
    onSubmit(value: { name: string; description: string }): unknown;
  },
): React.ReactElement {
  const [name, setName] = useState(initial.name ?? "");
  const [text, setText] = useState(initial.description ?? "");
  const key = `${open}:${initial.name ?? ""}:${initial.description ?? ""}`;
  const seen = useRef(key);
  if (seen.current !== key) {
    seen.current = key;
    if (open) {
      setName(initial.name ?? "");
      setText(initial.description ?? "");
    }
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      submitLabel={submitLabel}
      canSubmit={Boolean(name.trim())}
      onSubmit={() => onSubmit({ name: name.trim(), description: text.trim() })}
    >
      <label className="grid gap-1.5 text-sm font-medium">
        {nameLabel}
        <Input
          autoFocus
          value={name}
          onChange={(event) =>
            setName((event.target as unknown as { value: string }).value)}
        />
      </label>
      {withDescription && (
        <label className="grid gap-1.5 text-sm font-medium">
          {descriptionLabel}
          <Textarea
            rows={3}
            value={text}
            className="min-h-20"
            onChange={(event) =>
              setText((event.target as unknown as { value: string }).value)}
          />
        </label>
      )}
    </FormDialog>
  );
}
