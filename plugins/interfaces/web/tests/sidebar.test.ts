/**
 * The sidebar folded to a rail, its logic: where this browser keeps it for each person, whether
 * it's a rail (as the person left it, else as the app starts it), the key that folds it, ⌘B on
 * Apple's computers and Ctrl+B elsewhere, and what its button says.
 */
import { assertEquals } from "@std/assert";
import { foldKeyOf, foldKeysOf, foldLabel, folds, railOf, sidebarKey } from "../shared/sidebar.ts";
import { test } from "../../../../testing/mod.ts";

test("as the person left it, else as the app starts it: whole unless it says rail", () => {
  assertEquals(sidebarKey("ana"), "copilotz-sidebar:ana");
  assertEquals(railOf(null), false);
  assertEquals(railOf(null, {}), false);
  assertEquals(railOf(null, null), false);
  assertEquals(railOf(null, { sidebar: "full" }), false);
  assertEquals(railOf(null, { sidebar: "rail" }), true);
  assertEquals(railOf("rail"), true);
  assertEquals(railOf("rail", { sidebar: "full" }), true);
  assertEquals(railOf("full", { sidebar: "rail" }), false);
  // Anything else kept is as if nothing were.
  assertEquals(railOf("open", { sidebar: "rail" }), true);
  assertEquals(railOf("open"), false);
});

test("the key that folds it: ⌘B on a Mac, Ctrl+B elsewhere, nothing else", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assertEquals(folds(key("b", { metaKey: true }), true), true);
  assertEquals(folds(key("B", { metaKey: true }), true), true);
  // On a Mac, Ctrl+B is the field's own (back a letter).
  assertEquals(folds(key("b", { ctrlKey: true }), true), false);
  assertEquals(folds(key("b", { ctrlKey: true }), false), true);
  assertEquals(folds(key("b", { metaKey: true }), false), false);
  assertEquals(folds(key("b", { metaKey: true, shiftKey: true }), true), false);
  assertEquals(folds(key("b", { ctrlKey: true, altKey: true }), false), false);
  assertEquals(folds(key("b", { metaKey: true, ctrlKey: true }), true), false);
  assertEquals(folds(key("k", { metaKey: true }), true), false);
  assertEquals(folds(key("b"), true), false);
  assertEquals([foldKeyOf(true), foldKeyOf(false)], ["⌘B", "Ctrl B"]);
  assertEquals([foldKeysOf(true), foldKeysOf(false)], ["Meta+B", "Control+B"]);
});

test("what its button says", () => {
  assertEquals(foldLabel(false), "Collapse sidebar");
  assertEquals(foldLabel(true), "Expand sidebar");
});
