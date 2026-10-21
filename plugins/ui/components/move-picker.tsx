/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Choose a Space for a conversation: search, "No Space", or a new Space. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Notice,
} from "@copilotz/copilotz/web/kit";
import { SpaceMark } from "./space-mark.tsx";

export type PickerSpace = Readonly<{ id: string; name: string }>;

export function MovePicker(
  { open, onOpenChange, title, current, spaces, onMove, onCreate }: {
    open: boolean;
    onOpenChange(open: boolean): void;
    /** The conversation being moved. */
    title: string;
    current: string | null;
    spaces: readonly PickerSpace[];
    onMove(spaceId: string | null): Promise<unknown>;
    /** Create a Space by name and resolve its id. */
    onCreate?(name: string): Promise<string | undefined>;
  },
): React.ReactElement {
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = spaces.filter((space) =>
    space.name.toLowerCase().includes(query.trim().toLowerCase())
  );
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      onOpenChange(false);
      setQuery("");
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const option = (
    id: string | null,
    label: string,
    mark: React.ReactNode,
  ) => (
    <li key={id ?? "none"}>
      <button
        type="button"
        disabled={busy || current === id}
        aria-current={current === id ? "true" : undefined}
        onClick={() => void run(() => onMove(id))}
        className={cn(
          "hover:bg-accent focus-visible:ring-ring/45 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-[3px] disabled:opacity-60",
          current === id && "bg-accent/60",
        )}
      >
        {mark}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {current === id && (
          <Check aria-hidden="true" className="text-muted-foreground size-4" />
        )}
      </button>
    </li>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError("");
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="gap-3">
        <DialogHeader>
          <DialogTitle>Move to a Space</DialogTitle>
          <DialogDescription className="truncate">{title}</DialogDescription>
        </DialogHeader>
        <label className="relative">
          <span className="sr-only">Search Spaces</span>
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            autoFocus
            value={query}
            placeholder="Search Spaces"
            className="pl-8"
            onChange={(event) =>
              setQuery((event.target as unknown as { value: string }).value)}
          />
        </label>
        <ul className="-mx-1 max-h-64 overflow-y-auto">
          {option(
            null,
            "No Space",
            <span className="bg-muted flex size-5 items-center justify-center rounded-md">
              <X aria-hidden="true" className="size-3" />
            </span>,
          )}
          {visible.map((space) =>
            option(
              space.id,
              space.name,
              <SpaceMark id={space.id} name={space.name} />,
            )
          )}
          {!visible.length && query && (
            <li className="text-muted-foreground px-2.5 py-3 text-sm">
              No Spaces match “{query}”.
            </li>
          )}
        </ul>
        {onCreate && (
          <form
            className="flex gap-2 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              void run(async () => {
                const created = await onCreate(trimmed);
                if (!created) throw new Error("The Space was not created.");
                await onMove(created);
              });
            }}
          >
            <Input
              value={name}
              aria-label="New Space name"
              placeholder="New Space name"
              disabled={busy}
              onChange={(event) =>
                setName((event.target as unknown as { value: string }).value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !name.trim()}
            >
              <Plus /> Create
            </Button>
          </form>
        )}
        {error && <Notice tone="error" title="Not moved">{error}</Notice>}
      </DialogContent>
    </Dialog>
  );
}
