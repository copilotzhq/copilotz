import { assertEquals } from "@std/assert";
import { adminActivityAction } from "./index.ts";

Deno.test("admin activity Action declares its canonical identity and schema", () => {
  assertEquals(adminActivityAction.id, "copilotz.admin.activity");
  assertEquals(adminActivityAction.inputSchema?.required, [
    "resource",
    "method",
  ]);
});
