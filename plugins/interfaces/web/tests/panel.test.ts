/**
 * The web shell's side panel, its logic: which pages offer it, how wide it
 * may be, where this browser keeps it for each person, and what its button
 * says.
 */
import { assertEquals } from "@std/assert";
import { keysOf, offered, toggleLabel, WIDTH, widthOf } from "../shared/panel.ts";
import { test } from "../../../../testing/mod.ts";

test("the panel is offered on the pages it's on, where there's a space", () => {
  const panel = { view: "space.panel", on: ["thread"], title: "Space" };
  assertEquals(offered(panel, "thread", "launch"), true);
  assertEquals(offered(panel, "thread", undefined), false);
  assertEquals(offered(panel, "space", "launch"), false);
  assertEquals(offered({ view: "space.panel" }, "thread", "launch"), false);
  assertEquals(offered(null, "thread", "launch"), false);
  assertEquals(offered({ view: "", on: ["thread"] }, "thread", "launch"), false);
});

test("its width: kept or dragged to, within what fits", () => {
  assertEquals(widthOf(null), WIDTH.start);
  assertEquals(widthOf("abc"), WIDTH.start);
  assertEquals(widthOf("500"), 500);
  assertEquals(widthOf(500.6), 501);
  assertEquals(widthOf(100), WIDTH.min);
  assertEquals(widthOf(5000), WIDTH.max);
});

test("what this browser keeps, by person, and what its button says", () => {
  assertEquals(keysOf("ana"), { open: "copilotz-panel:ana", width: "copilotz-panel-width:ana" });
  assertEquals(toggleLabel(false, "Space"), "Show the space panel");
  assertEquals(toggleLabel(true, "Space"), "Hide the space panel");
  assertEquals(toggleLabel(true), "Hide the panel");
});
