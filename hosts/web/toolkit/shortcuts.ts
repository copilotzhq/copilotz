/**
 * A screen's keyboard shortcuts: keys bound to its commands while it shows
 * (a register's Alt+1 to Alt+9, Escape to cancel a sale, Mod+S to save).
 *
 * ```tsx
 * useShortcuts({
 *   "Alt+1": () => focusItem(),
 *   "Mod+S": save,
 *   "Escape": { run: cancel, inFields: true },
 * });
 * <Kbd>{shortcutLabel("Alt+1")}</Kbd>
 * ```
 *
 * A shortcut is its modifiers and a key, joined by `+`: `Mod` (⌘ on Apple's
 * computers, Ctrl elsewhere), `Ctrl`, `Meta` (or `Cmd`), `Alt` (⌥), `Shift`;
 * and a character (`S`, `1`, `?`) or a key's name (`Escape`, `Enter`,
 * `ArrowUp`, `F2`, `Space`). Letters and digits match by the key pressed, so
 * Alt+1 works where ⌥1 types "¡". The modifiers must be just those (a
 * symbol's own Shift aside: `?` is Shift+/ on most keyboards).
 *
 * It's heard on the page as a key press bubbles up, after the focused
 * control: one that took the key (a menu's arrows, a field's Enter) keeps it,
 * and the shell's own (⌘K for the palette, ⌘B for the sidebar) come first.
 * It's skipped while a dialog or a menu is open over the screen, so Escape
 * closes that, not the sale (a screen in a dialog passes `within`, its
 * element, and keeps its keys there); skipped as someone types in a field,
 * unless it says `inFields`; and skipped when held down, unless it says
 * `repeat`. One it runs isn't the browser's too (Mod+S saves no page).
 * `shortcutLabel` writes one as the computer shows it: `⌥1`, `Alt+1`.
 */
import { type RefObject, useEffect, useMemo, useRef } from "react";

/** A shortcut, read: its key and the modifiers it needs. */
export type Chord = {
  /** The key: a lowercase character, or a key's name as `KeyboardEvent.key` says it. */
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/** What runs, or what runs and when. */
export type Binding = ((event: KeyboardEvent) => void) | {
  run(event: KeyboardEvent): void;
  /** Also while someone types in a field. */
  inFields?: boolean;
  /** Also again and again while it's held down. */
  repeat?: boolean;
};

/** A key press, as much of it as a shortcut reads. */
export type Press = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Whether this is one of Apple's computers, where Mod is ⌘. */
export const apple = (platform: string = globalThis.navigator?.platform ?? ""): boolean =>
  /Mac|iP(hone|ad|od)/.test(platform);

/** Keys' other names, as people write them. */
const NAMES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: " ",
  spacebar: " ",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  plus: "+",
};

/** Reads a shortcut (`"Alt+1"`, `"Mod+Shift+S"`, `"Escape"`) for this computer. */
export function parseShortcut(text: string, mac = apple()): Chord {
  // The last part is the key; "+" itself is written "Plus" or as a last "+" ("Ctrl++").
  const parts = text.trim().endsWith("++")
    ? [...text.trim().slice(0, -2).split("+"), "+"]
    : text.trim().split("+");
  const chord: Chord = { key: "", ctrl: false, meta: false, alt: false, shift: false };
  parts.forEach((part, i) => {
    const word = part.trim();
    const lower = word.toLowerCase();
    if (i < parts.length - 1) {
      if (lower === "mod") chord[mac ? "meta" : "ctrl"] = true;
      else if (lower === "ctrl" || lower === "control") chord.ctrl = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command") chord.meta = true;
      else if (lower === "alt" || lower === "option" || lower === "opt") chord.alt = true;
      else if (lower === "shift") chord.shift = true;
      else throw new Error(`shortcut "${text}": "${word}" is not a modifier`);
      return;
    }
    if (!word && part !== " ") throw new Error(`shortcut "${text}" has no key`);
    const named = NAMES[lower] ?? (/^f\d{1,2}$/.test(lower) ? word.toUpperCase() : undefined);
    chord.key = named ?? (word.length === 1 ? lower : word);
  });
  return chord;
}

/** A letter or a digit: matched by the key pressed, whatever it types with Alt. */
const physical = (key: string) =>
  /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : undefined;

/** Whether a key press is this shortcut. */
export function matches(chord: Chord, press: Press): boolean {
  const pressed = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  const code = physical(chord.key);
  const same = pressed === chord.key || (code !== undefined && press.code === code) ||
    (/^\d$/.test(chord.key) && press.code === `Numpad${chord.key}`);
  if (!same) return false;
  // A symbol's own Shift (`?`, `!`) is part of typing it.
  const symbol = chord.key.length === 1 && code === undefined && chord.key !== " ";
  return press.ctrlKey === chord.ctrl && press.metaKey === chord.meta &&
    press.altKey === chord.alt &&
    (symbol || press.shiftKey === chord.shift);
}

/** How keys' names show in a label. */
const SHOWN: Record<string, [apple: string, other: string]> = {
  Escape: ["esc", "Esc"],
  Enter: ["↩", "Enter"],
  " ": ["Space", "Space"],
  Tab: ["⇥", "Tab"],
  Backspace: ["⌫", "Backspace"],
  Delete: ["⌦", "Del"],
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  PageUp: ["⇞", "PgUp"],
  PageDown: ["⇟", "PgDn"],
};

/** A shortcut as this computer writes it: `⌥⇧S` on a Mac, `Alt+Shift+S` elsewhere. */
export function shortcutLabel(text: string, mac: boolean = apple()): string {
  const chord = parseShortcut(text, mac);
  const shown = SHOWN[chord.key]?.[mac ? 0 : 1] ?? chord.key.toUpperCase();
  if (mac) {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${
      chord.meta ? "⌘" : ""
    }${shown}`;
  }
  return [
    chord.ctrl && "Ctrl",
    chord.meta && "Win",
    chord.alt && "Alt",
    chord.shift && "Shift",
    shown,
  ].filter(Boolean).join("+");
}

/** Whether a key press is someone typing: in a field, or in text being edited. */
const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return !!element &&
    (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? ""));
};

/**
 * Whether something is open over the page that isn't where the shortcuts are:
 * a modal dialog, or a popover that closes on a click outside (a menu).
 */
function covered(within: HTMLElement | null | undefined): boolean {
  let open: Element[] = [];
  try {
    open = [...document.querySelectorAll("dialog:modal, [popover]:popover-open")];
  } catch {
    // A browser without :modal or :popover-open: any open dialog counts.
    open = [...document.querySelectorAll("dialog[open]")];
  }
  return open.some((layer) =>
    layer.getAttribute("popover") !== "manual" && !(within && layer.contains(within))
  );
}

/** Binds a screen's shortcuts while it shows (see the top of this file). */
export function useShortcuts(
  shortcuts: Record<string, Binding>,
  { enabled = true, within }: {
    /** Off while false (a screen still loading, a mode that has none). */
    enabled?: boolean;
    /** The screen's own element, when it's inside a dialog or a popover: its keys work there. */
    within?: RefObject<HTMLElement | null>;
  } = {},
): void {
  // The latest bindings, read as a key is pressed: rebinding never misses one.
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  const keys = Object.keys(shortcuts).join("\n");
  const chords: (readonly [string, Chord])[] = useMemo(
    () => Object.keys(shortcuts).map((text) => [text, parseShortcut(text)] as const),
    [keys],
  );
  useEffect(() => {
    if (!enabled) return;
    const pressed = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const found = chords.find(([, chord]) => matches(chord, event));
      if (!found) return;
      const binding = latest.current[found[0]];
      if (!binding) return;
      const run = typeof binding === "function" ? binding : binding.run;
      const options: { inFields?: boolean; repeat?: boolean } = typeof binding === "function"
        ? {}
        : binding;
      if (event.repeat && !options.repeat) return;
      if (typing(event.target) && !options.inFields) return;
      if (covered(within?.current)) return;
      event.preventDefault();
      run(event);
    };
    document.addEventListener("keydown", pressed);
    return () => document.removeEventListener("keydown", pressed);
  }, [enabled, chords]);
}
