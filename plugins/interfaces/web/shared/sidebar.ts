/**
 * The sidebar on a wide screen: whole, or folded to a rail of icons (the app's
 * mark, a way to unfold it, search, what sections offer there, the person).
 * What this browser keeps of it for each person (whole or a rail), so it's as
 * they left it on the next page and next time; until they choose, as the app
 * starts it (the `shell` resource's `sidebar`: whole unless it says `rail`).
 * The key that folds and unfolds it: ⌘B on Apple's computers, Ctrl+B
 * elsewhere (on a Mac, Ctrl+B is the field's own: it moves back a letter).
 */
import { say } from "../views/words.ts";

/** The `shell` resource: the web shell's settings. */
export type ShellSettings = {
  /** How the sidebar starts on a wide screen, until the person chooses: `full` (whole) or `rail`. */
  sidebar?: "full" | "rail";
};

/** Where this browser keeps the sidebar's state, for each person. */
export const sidebarKey = (viewer: string) => `copilotz-sidebar:${viewer}`;

/** Whether the sidebar is a rail: as the person left it, else as the app starts it. */
export function railOf(kept: string | null, settings?: ShellSettings | null): boolean {
  if (kept === "rail" || kept === "full") return kept === "rail";
  return settings?.sidebar === "rail";
}

/** Whether a key press folds (or unfolds) the sidebar. */
export function folds(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "b" || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The key, as a keycap says it, and as `aria-keyshortcuts` does. */
export const foldKeyOf = (mac: boolean) => mac ? "⌘B" : "Ctrl B";
export const foldKeysOf = (mac: boolean) => mac ? "Meta+B" : "Control+B";

/** What its button says: "Collapse sidebar", "Expand sidebar". */
export const foldLabel = (rail: boolean) => say(rail ? "expandSidebar" : "collapseSidebar");
