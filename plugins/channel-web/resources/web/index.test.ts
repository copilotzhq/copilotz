import { assertEquals } from "@std/assert";
import { createWebChannelResource } from "./index.ts";

Deno.test("Web Channel Resource snapshots request-observation policy", () => {
  const aliases = ["assistant"];
  const resource = createWebChannelResource({ defaultAgentAliases: aliases });
  aliases[0] = "changed";
  assertEquals(resource.egress, "request-observation");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
