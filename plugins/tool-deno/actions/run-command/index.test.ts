import { assertEquals } from "@std/assert";
import { runCommandAction } from "./index.ts";

Deno.test("run_command Action keeps its durable id", () => {
  assertEquals(runCommandAction.id, "copilotz.tools.deno.run_command");
});
