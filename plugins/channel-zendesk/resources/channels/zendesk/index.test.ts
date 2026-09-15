import { assertEquals } from "@std/assert";
import { zendeskChannelResource } from "./index.ts";

Deno.test("Zendesk Channel Resource is data-only external policy", () => {
  const resource = {
    ...zendeskChannelResource,
    ...{
      defaultAgentAliases: ["assistant"],
    },
  };
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
