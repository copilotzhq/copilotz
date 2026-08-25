import { assertEquals } from "@std/assert";
import { runCommandTool } from "./index.ts";

Deno.test("run_command Tool maps to its Action alias", () => {
  assertEquals(runCommandTool.action, "run_command");
});
