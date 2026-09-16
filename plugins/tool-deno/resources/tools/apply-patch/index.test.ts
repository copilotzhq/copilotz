import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { applyPatchTool } from "./index.ts";

Deno.test("apply_patch Tool maps to its Action alias", () => {
  assertEquals(
    applyPatchTool[contribution]({ namespace: "tools", alias: "apply_patch" })
      .value.action,
    "apply_patch",
  );
});
