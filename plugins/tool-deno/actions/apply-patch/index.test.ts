import { assertEquals } from "@std/assert";
import { applyPatchAction } from "./index.ts";

Deno.test("apply_patch Action keeps its durable id", () => {
  assertEquals(applyPatchAction.id, "copilotz.tools.deno.apply_patch");
});
