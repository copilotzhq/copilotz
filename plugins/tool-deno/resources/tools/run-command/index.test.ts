import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { runCommandTool } from "./index.ts";

Deno.test("run_command Tool maps to its Action alias", () => {
  assertEquals(
    runCommandTool[contribution]({ namespace: "tools", alias: "run_command" })
      .value.action,
    "run_command",
  );
});
