/**
 * The command palette, as front ends speak to it: what an item is (a place
 * to go, a step to open, something to do), a group of them, a step (a list
 * of its own, such as "Move to…" then a space), and what an item may do
 * with the palette while it's chosen. And whether it's open, and at which
 * step: `openPalette` opens it from anywhere (an item's menu, at "Move
 * to…"), as `go` moves on from anywhere.
 */
import type { ReactNode } from "react";
import type { IconName } from "../toolkit/icon.tsx";

/** What an item (or a step's View) may do with the palette while it's chosen. */
export type PaletteControl = {
  /** What's typed. */
  search: string;
  /** Opens a step over this one. */
  push(step: PaletteStep): void;
  /** Back to the step before; from the first, it closes. */
  back(): void;
  close(): void;
  /**
   * Hands `value` to the nearest step that asked for one (its `pick`): a
   * space picked, for a move there. What it returns, the item's `run` does.
   */
  pick(value: unknown): Promise<unknown>;
  /** Closes the palette and shows a View in a dialog instead: a form (inviting someone). */
  dialog(shown: PaletteDialog): void;
};

/** One thing to choose. */
export type PaletteItem = {
  /** Unique in the palette (`space:<id>`): what keeps it chosen while the list changes. */
  key: string;
  label: string;
  icon?: IconName;
  /** Before the label instead of an icon: an avatar. */
  leading?: ReactNode;
  /** A quieter word after the label: where it is, what it is. */
  description?: string;
  /** More words it's found by (what a chat said). */
  keywords?: string[];
  /** Where choosing it goes … */
  href?: string;
  /** … the step it opens (a space to move to) … */
  step?: PaletteStep;
  /**
   * … or what it does. While a promise it returns is pending, the item is
   * busy; settled, the palette closes (unless it opened a step or a
   * dialog); failed, it says why and stays.
   */
  run?(palette: PaletteControl): unknown;
  tone?: "destructive";
  disabled?: boolean;
  /** A key that does it too, as shown: "⌘K". */
  shortcut?: string;
};

/** Items under a heading. Groups with the same heading, from several front ends, are one. */
export type PaletteGroup = {
  /** Its heading; none for a step's plain list. */
  title: string;
  /** Where it goes, lowest first; while searching, the best match goes first. */
  order?: number;
  /** At most this many show. */
  limit?: number;
  items: PaletteItem[];
};

/** A list of its own, over the one before: "Move “Plan” to…", then the spaces. */
export type PaletteStep = {
  /** What it's for, beside the field. */
  title: string;
  placeholder?: string;
  /** What the field starts with: a name to change. */
  value?: string;
  /** A line under the field: what choosing here does. */
  note?: string;
  /** The View that lists its items (it returns groups), with its item and hints (and `search`) … */
  view?: string;
  item?: unknown;
  hints?: Record<string, unknown>;
  /** … or its items, for what's typed. */
  items?(search: string): PaletteGroup[];
  /** Whether what's typed filters its items: not when it's a name being typed. */
  filter?: boolean;
  /** A question to answer (archive it?): no field, only its choices, the first chosen by Enter. */
  confirm?: boolean;
  /** What a picked value does: a space picked, the move there. */
  pick?(value: unknown): unknown;
};

/** A View shown in a dialog, from the palette. */
export type PaletteDialog = {
  title: string;
  description?: string;
  view: string;
  item?: unknown;
  hints?: Record<string, unknown>;
  size?: "sm" | "md" | "lg";
};

type State = { open: boolean; steps: PaletteStep[] };

let state: State = { open: false, steps: [] };
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const listener of listeners) listener();
};

/** The palette's state, for the component that shows it. */
export const paletteState = {
  get: (): State => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Opens the palette: at its first step, or at `step` (from an item's menu: "Move to…"). */
export function openPalette(step?: PaletteStep): void {
  set({ open: true, steps: step ? [step] : [] });
}

export function closePalette(): void {
  if (state.open) set({ open: false, steps: [] });
}
