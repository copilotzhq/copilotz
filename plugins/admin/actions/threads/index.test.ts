import { assertEquals } from "@std/assert";
import { adminThreadsAction } from "./index.ts";

Deno.test("admin threads Action declares its canonical identity and schema", () => {
  assertEquals(adminThreadsAction.id, "copilotz.admin.threads");
  assertEquals(adminThreadsAction.inputSchema?.required, [
    "resource",
    "method",
  ]);
});
