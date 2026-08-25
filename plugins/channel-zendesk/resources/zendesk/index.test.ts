import { assertEquals } from "@std/assert";
import { createZendeskChannelResource } from "./index.ts";

Deno.test("Zendesk Channel Resource is data-only external policy", () => {
  const resource = createZendeskChannelResource({
    defaultAgentAliases: ["assistant"],
  });
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
