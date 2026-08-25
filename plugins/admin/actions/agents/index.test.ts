import { assertEquals } from "@std/assert";
import { adminAgentsAction } from "./index.ts";

Deno.test("admin agents Action declares its canonical identity and schema", () => {
  assertEquals(adminAgentsAction.id, "copilotz.admin.agents");
  assertEquals(adminAgentsAction.inputSchema?.required, ["resource", "method"]);
});
