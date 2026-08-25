import { assertEquals } from "@std/assert";
import { adminOverviewAction } from "./index.ts";

Deno.test("admin overview Action declares its canonical identity and schema", () => {
  assertEquals(adminOverviewAction.id, "copilotz.admin.overview");
  assertEquals(adminOverviewAction.inputSchema?.required, [
    "resource",
    "method",
  ]);
});
