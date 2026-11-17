/**
 * A screen's shortcuts: read once (Mod is ⌘ on a Mac, Ctrl elsewhere),
 * matched to key presses (letters and digits by the key pressed, whatever
 * Alt makes them type; a symbol's own Shift aside), and written as the
 * computer shows them.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { matches, parseShortcut, shortcutLabel } from "../toolkit/shortcuts.ts";

const press = (key: string, more: Partial<Record<string, unknown>> = {}) => ({
  key,
  code: undefined as string | undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...more,
});

test("reading a shortcut: modifiers, Mod by computer, keys by name", () => {
  assertEquals(parseShortcut("Alt+1", false), {
    key: "1",
    ctrl: false,
    meta: false,
    alt: true,
    shift: false,
  });
  assertEquals(parseShortcut("Mod+S", true).meta, true);
  assertEquals(parseShortcut("Mod+S", false).ctrl, true);
  assertEquals(parseShortcut("esc", false).key, "Escape");
  assertEquals(parseShortcut("Ctrl+Shift+ArrowUp", false).key, "ArrowUp");
  assertEquals(parseShortcut("Space", false).key, " ");
  assertEquals(parseShortcut("f2", false).key, "F2");
  assertEquals(parseShortcut("Ctrl++", false).key, "+");
  assertThrows(() => parseShortcut("Hyper+K", false), Error, "not a modifier");
});

test("matching: the modifiers exactly, letters and digits by the key pressed", () => {
  const altOne = parseShortcut("Alt+1", true);
  // On a Mac, ⌥1 types "¡": the key pressed is still Digit1.
  assert(matches(altOne, press("¡", { code: "Digit1", altKey: true })));
  assert(matches(altOne, press("1", { code: "Numpad1", altKey: true })));
  assert(!matches(altOne, press("1", { code: "Digit1" })));
  assert(!matches(altOne, press("1", { code: "Digit1", altKey: true, ctrlKey: true })));
  const save = parseShortcut("Mod+S", false);
  assert(matches(save, press("s", { code: "KeyS", ctrlKey: true })));
  assert(!matches(save, press("S", { code: "KeyS", ctrlKey: true, shiftKey: true })));
  assert(matches(parseShortcut("Escape", false), press("Escape")));
  // `?` is Shift+/ on most keyboards: its Shift is part of it.
  assert(matches(parseShortcut("?", false), press("?", { shiftKey: true })));
});

test("labels: as a Mac shows them, and as other computers do", () => {
  assertEquals(shortcutLabel("Alt+1", true), "⌥1");
  assertEquals(shortcutLabel("Mod+Shift+S", true), "⇧⌘S");
  assertEquals(shortcutLabel("Ctrl+Alt+Delete", true), "⌃⌥⌦");
  assertEquals(shortcutLabel("Alt+1", false), "Alt+1");
  assertEquals(shortcutLabel("Mod+Shift+S", false), "Ctrl+Shift+S");
  assertEquals(shortcutLabel("Escape", false), "Esc");
  assertEquals(shortcutLabel("Escape", true), "esc");
});
