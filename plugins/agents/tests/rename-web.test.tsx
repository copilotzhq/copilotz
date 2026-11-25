/**
 * Renaming a chat from the command palette: its title ready to type over,
 * then "Rename to “…”", which renames it (`chat.rename`). Nothing to choose
 * until the title changes; one too long says so instead.
 */
import { assertEquals } from "@std/assert";
import type { PaletteControl } from "../../../hosts/web/mod.ts";
import { test } from "../../../testing/mod.ts";
import { renameStep } from "../chat/views/web/rename.tsx";

test("renaming a chat starts from its title, and renames it to what's typed", async () => {
  const calls: unknown[][] = [];
  const call = <R,>(action: string, input?: unknown) => {
    calls.push([action, input]);
    return Promise.resolve({} as R);
  };
  const step = renameStep({ thread: "t1", title: "the plan for the quarter", call });
  assertEquals([step.title, step.value, step.filter], [
    "Rename “the plan for the quarter”",
    "the plan for the quarter",
    false,
  ]);
  // Nothing to choose until it says something else.
  assertEquals(step.items!("the plan for the quarter"), []);
  assertEquals(step.items!("   "), []);
  const [{ items: [item] }] = step.items!("  Q3   plan ");
  assertEquals([item.label, item.disabled], ["Rename to “Q3 plan”", false]);
  await item.run!({} as PaletteControl);
  assertEquals(calls, [["chat.rename", { thread: "t1", title: "Q3 plan" }]]);
  // Too long: it says how long it may be.
  const [{ items: [long] }] = step.items!("x".repeat(121));
  assertEquals([long.disabled, long.description], [true, "At most 120 characters"]);
});
