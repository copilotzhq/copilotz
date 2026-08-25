import { assertEquals } from "@std/assert";
import { applyPatchTool } from "./index.ts";

Deno.test("apply_patch Tool maps to its Action alias", () => {
  assertEquals(applyPatchTool.action, "apply_patch");
});
