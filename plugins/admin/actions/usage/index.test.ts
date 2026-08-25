import { assertEquals } from "@std/assert";
import { adminUsageAction } from "./index.ts";

Deno.test("admin usage Action declares its canonical identity and schema", () => {
  assertEquals(adminUsageAction.id, "copilotz.admin.usage");
  assertEquals(adminUsageAction.inputSchema?.required, ["resource", "method"]);
});
